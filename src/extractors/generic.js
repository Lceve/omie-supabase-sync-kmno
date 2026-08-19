'use strict';

const { fetchAll } = require('../omieClient');

/**
 * Generic Omie extractor driven by a registry entry.
 *
 * The entry contract is documented in config/omie-tables.js.
 * Every entry can be used as-is; no per-table extractor needed.
 */
function makeExtractor(entry) {
  return async (since = null, full = false) => {
    // Registry entries opt into incremental sync by declaring a
    // `sinceDateField` (or `defaultSinceDays`).  When neither is set,
    // we never send a date filter — most Omie lookup endpoints
    // (crm/fases, geral/parcelas, geral/categorias, …) reject the
    // implicit `filtrar_por_data_de` with a 500.  Lookup tables are
    // small enough to refetch in full every run.
    const acceptsSince = !!(entry.sinceDateField || entry.defaultSinceDays);
    const effectiveSince = acceptsSince ? since : null;

    return fetchAll(
      entry.endpoint,
      entry.action,
      entry.params || {},
      entry.listKey,
      effectiveSince,
      entry.sinceDateField || null,
      entry.sinceEndDateField || null,
      {
        paginationStyle: entry.paginationStyle,
        pageParam: entry.pageParam,
        sizeParam: entry.sizeParam,
        totalPagesField: entry.totalPagesField,
        paginated: entry.paginated,
        defaultSinceDays: entry.defaultSinceDays,
        full,
      }
    );
  };
}

module.exports = { makeExtractor };
