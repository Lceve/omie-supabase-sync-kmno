const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const config = require('./config');
const logger = require('./logger');

const OMIE_EMPTY_PAGE = Symbol('OMIE_EMPTY_PAGE');

const http = axios.create({
  baseURL: config.omie.baseUrl,
  timeout: config.omie.requestTimeoutMs,
});

/**
 * Pagination style presets. Omie endpoints come in four different
 * flavours of pagination parameters and three different total-pages
 * field names. Each registry entry can pick one with `paginationStyle`,
 * or override the individual fields directly.
 */
const PAGINATION_STYLES = {
  standard:     { pageParam: 'pagina',  sizeParam: 'registros_por_pagina',   totalPagesField: 'total_de_paginas' },
  new:          { pageParam: 'nPagina', sizeParam: 'nRegPorPagina',          totalPagesField: 'nTotPaginas' },
  nfe:          { pageParam: 'nPagina', sizeParam: 'nRegistrosPorPagina',    totalPagesField: 'nTotalPaginas' },
  pedidocompra: { pageParam: 'nPagina', sizeParam: 'nRegsPorPagina',         totalPagesField: 'nTotalPaginas' },
};

axiosRetry(http, {
  retries: config.omie.maxRetries,
  retryDelay: (count, err) => {
    const fs = err?.response?.data?.faultstring;
    const m = typeof fs === 'string' ? fs.match(/Aguarde (\d+) segundos/i) : null;
    if (m) return parseInt(m[1], 10) * 1000 + 500;
    return count * 1000;
  },
  retryCondition: (err) => {
    const fs = err?.response?.data?.faultstring;
    const isKnownTransient500 =
      err?.response?.status === 500 &&
      typeof fs === 'string' &&
      (fs.includes('Consumo redundante') || fs.includes('Broken response'));
    return (
      axiosRetry.isNetworkOrIdempotentRequestError(err) ||
      err?.response?.status === 429 ||
      isKnownTransient500
    );
  },
  onRetry: (count, err) =>
    logger.warn(`Omie retry #${count}`, { error: err.message }),
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isOmieEmptyPageFault(payload) {
  if (!payload || typeof payload.faultstring !== 'string') return false;
  const { faultstring: fs, faultcode: code } = payload;
  return (
    code === 'SOAP-ENV:Client-5094' ||
    code === 'SOAP-ENV:Client-5113' ||
    code === 'SOAP-ENV:Client-101' ||      // "Nenhum/a ... foi encontrado/a!" — empty result set
    fs.includes('Não existem registros para a página') ||
    /Nenhum[a]?\s.+\sencontrad[ao]/i.test(fs)
  );
}

/**
 * Make a single call to the Omie API.
 *
 * On HTTP error we surface Omie's `faultstring` (when present) in the
 * thrown Error so the failure is diagnosable from `sync_log`.
 */
async function call(endpoint, action, params = {}) {
  try {
    const { data } = await http.post(`/${endpoint}/`, {
      call: action,
      app_key: config.omie.appKey,
      app_secret: config.omie.appSecret,
      param: [params],
    });

    if (data.faultstring) throw new Error(`Omie fault: ${data.faultstring}`);
    return data;
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    if (status === 500 && isOmieEmptyPageFault(data)) return OMIE_EMPTY_PAGE;
    if (data && (data.faultstring || data.faultcode)) {
      const fault = [data.faultcode, data.faultstring].filter(Boolean).join(' — ');
      const wrapped = new Error(`HTTP ${status} on ${endpoint}/${action}: ${fault}`);
      wrapped.original = err;
      wrapped.omieFault = data;
      throw wrapped;
    }
    throw err;
  }
}

/**
 * Locate the first property in a response object whose value is an array
 * of objects. Used as a safety net when the configured `listKey` does
 * not match the actual Omie response shape.
 *
 * Skips known pagination / metadata keys.
 */
const META_KEYS = new Set([
  'pagina',
  'total_de_paginas',
  'registros',
  'total_de_registros',
  'nTotPaginas',
  'nPagina',
  'nTotRegistros',
  'nRegistros',
]);

function findFirstArrayKey(obj) {
  if (!obj || typeof obj !== 'object') return null;
  for (const [key, value] of Object.entries(obj)) {
    if (META_KEYS.has(key)) continue;
    if (Array.isArray(value) && value.length && typeof value[0] === 'object') {
      return key;
    }
  }
  return null;
}

function fmtDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/**
 * Fetch ALL records from an Omie list endpoint.
 *
 * Backwards-compatible positional signature for legacy extractors:
 *   fetchAll(endpoint, action, params, listKey, since, sinceDateField, sinceEndDateField)
 *
 * The 8th `options` argument unlocks per-endpoint behaviour:
 *   {
 *     paginationStyle: 'standard' | 'new' | 'nfe' | 'pedidocompra',
 *     pageParam, sizeParam, totalPagesField,
 *     paginated: boolean,           // false → single call, no pagination params
 *     defaultSinceDays: number,     // default lookback when `since` is null
 *   }
 */
async function fetchAll(
  endpoint,
  action,
  params = {},
  listKey,
  since = null,
  sinceDateField = null,
  sinceEndDateField = null,
  options = {}
) {
  const style = PAGINATION_STYLES[options.paginationStyle || 'standard'] || PAGINATION_STYLES.standard;
  const pageParam       = options.pageParam       || style.pageParam;
  const sizeParam       = options.sizeParam       || style.sizeParam;
  const totalPagesField = options.totalPagesField || style.totalPagesField;
  const paginated       = options.paginated !== false;

  // Default-since: if the registry asked for an N-day lookback and we
  // don't have a since timestamp, materialize one. This avoids 500s on
  // endpoints that REQUIRE a date range (NF-e, financial movements, …).
  let effectiveSince = since;
  if (!effectiveSince && options.defaultSinceDays) {
    effectiveSince = new Date(Date.now() - options.defaultSinceDays * 86400000);
  }

  const records = [];
  let page = 1;
  let totalPages = 1;
  let resolvedKey = listKey;

  const baseParams = { ...params };

  if (paginated) {
    baseParams[pageParam] = page;
    baseParams[sizeParam] = config.omie.pageSize;
  }

  if (effectiveSince) {
    const dateStr = fmtDate(effectiveSince);
    if (sinceDateField) {
      baseParams[sinceDateField] = dateStr;
      if (sinceEndDateField) {
        baseParams[sinceEndDateField] = fmtDate(new Date());
      }
    } else if (paginated) {
      // Only legacy/standard endpoints get the implicit filter
      baseParams.filtrar_por_data_de = dateStr;
    }
  }

  do {
    logger.debug(`Fetching ${endpoint}/${action} page ${page}/${totalPages}`);
    const callParams = paginated ? { ...baseParams, [pageParam]: page } : baseParams;
    const result = await call(endpoint, action, callParams);

    if (result === OMIE_EMPTY_PAGE) break;

    let list = resolvedKey ? result[resolvedKey] : null;
    if (!Array.isArray(list)) {
      const detected = findFirstArrayKey(result);
      if (detected) {
        if (detected !== resolvedKey) {
          logger.debug(
            `Auto-detected list key "${detected}" for ${endpoint}/${action}` +
              (resolvedKey ? ` (configured "${resolvedKey}" not found)` : '')
          );
        }
        resolvedKey = detected;
        list = result[resolvedKey];
      }
    }
    if (Array.isArray(list)) records.push(...list);

    if (!paginated) break;

    totalPages =
      result[totalPagesField] ||
      result.total_de_paginas ||
      result.nTotPaginas ||
      result.nTotalPaginas ||
      result.total_pages ||
      1;
    page++;

    if (page <= totalPages) await sleep(config.omie.requestDelayMs);
  } while (page <= totalPages);

  return records;
}

module.exports = { call, fetchAll, findFirstArrayKey, PAGINATION_STYLES };
