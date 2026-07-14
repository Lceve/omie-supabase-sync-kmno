'use strict';

/**
 * Registry-driven transformer.
 *
 * Reads `columns` and `children` from a `config/omie-tables.js` entry
 * and turns raw Omie list-records into flat Postgres rows. No `raw`,
 * no jsonb — every field is mapped to a typed column.
 *
 * Output shape:
 *   {
 *     parent: [ { omie_id, col1, col2, ..., synced_at }, ... ],
 *     children: {
 *       <child_table>: [ { id, <parentRefColumn>, col1, ..., synced_at }, ... ],
 *       ...
 *     }
 *   }
 *
 * The loader walks `parent` first and then every child table, so FK
 * constraints can be honoured.
 */

const crypto = require('crypto');

const FALLBACK_ID_FIELDS = [
  'codigo',
  'cCodigo',
  'nCodigo',
  'codigo_lancamento_omie',
  'codigo_pedido',
  'codigo_cliente_omie',
  'codigo_produto',
  'nCod',
  'nCodCC',
  'nCodCR',
  'nCodCP',
  'nCodNF',
  'nCodNFSe',
  'nCodNFCe',
  'nCodCTe',
  'nIdNF',
  'nIdNfse',
  'nIdNFCe',
  'nIdCTe',
  'nIdAjuste',
  'nIdMovEst',
  'nIdLote',
  'nIdEstrutura',
  'nIdOp',
  'nIdContrato',
  'nIdNfEnt',
  'nCodOp',
  'nCodTitulo',
  'nCodPedido',
  'nCodCtr',
  'nCodLanc',
  'nCodPix',
  'nCodBoleto',
  'nCodTabPreco',
  'nCodFase',
  'nCodStatus',
  'nCodOrigem',
  'nCodCaract',
  'nCodTag',
  'nCodComprador',
  'nCodLoc',
  'nCodVariacao',
  'nCodContato',
  'nCodMovimento',
];

function isBlank(v) {
  return v === null || v === undefined || v === '';
}

function getPath(obj, path) {

  if (!obj || !path) return null;
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return null;
    cur = cur[p];
  }
  return cur === undefined ? null : cur;
}

function toNumeric(v) {
  if (isBlank(v)) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim().replace(/\./g, '').replace(',', '.');
  if (!/^-?[0-9]+(\.[0-9]+)?$/.test(s)) {
    const t = String(v).trim();
    if (!/^-?[0-9]+(\.[0-9]+)?$/.test(t)) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function toBigint(v) {
  if (isBlank(v)) return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    return Math.trunc(v);
  }
  const s = String(v).trim();
  if (!/^-?[0-9]+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function toDate(v) {
  if (isBlank(v)) return null;
  const s = String(v).trim();
  let m = s.match(/^([0-9]{2})\/([0-9]{2})\/([0-9]{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = s.match(/^([0-9]{4})-([0-9]{2})-([0-9]{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

function toTimestamptz(v) {
  if (isBlank(v)) return null;
  if (v instanceof Date) return v.toISOString();
  const s = String(v).trim();
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

function toBoolean(v, inverted = false) {
  if (isBlank(v)) return null;
  if (typeof v === 'boolean') return inverted ? !v : v;
  const s = String(v).trim().toUpperCase();
  if (s === 'S' || s === 'SIM' || s === 'TRUE' || s === '1') return inverted ? false : true;
  if (s === 'N' || s === 'NAO' || s === 'NÃO' || s === 'FALSE' || s === '0') return inverted ? true : false;
  return null;
}

function castValue(rawValue, type) {
  switch (type || 'text') {
    case 'text':
      return isBlank(rawValue) ? null : String(rawValue);
    case 'numeric':
      return toNumeric(rawValue);
    case 'bigint':
      return toBigint(rawValue);
    case 'date':
      return toDate(rawValue);
    case 'timestamptz':
      return toTimestamptz(rawValue);
    case 'boolean':
      return toBoolean(rawValue, false);
    case 'boolean_inverted':
      return toBoolean(rawValue, true);
    default:
      throw new Error(`Unknown column type: ${type}`);
  }
}

function resolveId(record, idFields, pkType, hashSeed = '') {
  const candidates = [...(idFields || []), ...FALLBACK_ID_FIELDS];
  for (const field of candidates) {
    // Composite key: an array entry means "concatenate these fields".
    // Used when a single field (e.g. nCodTitulo) is shared by multiple
    // rows (e.g. one per parcela/movimento) and is not unique alone.
    if (Array.isArray(field)) {
const parts = field.map((f) => getPath(record, f)).filter((p) => !isBlank(p));
if (parts.length === 0) continue; // nothing usable at all
return parts.map((p) => String(p)).join('|');
    }
    const value = getPath(record, field);
    if (!isBlank(value)) {
      if (pkType === 'bigint') {
        const n = toBigint(value);
        if (n !== null) return n;
      } else {
        return String(value);
      }
    }
  }
  if (pkType === 'bigint') {
    return null;
  }
  const hash = crypto
    .createHash('sha1')
    .update(hashSeed + JSON.stringify(record))
    .digest('hex')
    .slice(0, 16);
  return `_hash_${hash}`;
}

function camelOrSnakeToSnake(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s\-]+/g, '_')
    .toLowerCase();
}

function pkColumnName(entry) {
  if (entry.pkColumn) return entry.pkColumn;
  if (entry.parentRefColumn) return 'omie_id';

  if (entry.legacy) {
    const firstId = entry.idFields && entry.idFields[0];
    if (firstId) {
      if (entry.columns) {
        const match = entry.columns.find((c) => c.from === firstId);
        if (match) return match.name;
      }
      if (!firstId.includes('.') && /^[a-z_][a-z0-9_]*$/i.test(firstId)) {
        return camelOrSnakeToSnake(firstId);
      }
    }
  }
  return 'omie_id';
}

function effectivePkType(entry) {
  if (entry.pkType) return entry.pkType;
  if (entry.parentRefColumn) return 'text';
  const pkCol = pkColumnName(entry);
  if (pkCol === 'omie_id') return 'text';
  const def = (entry.columns || []).find((c) => c.name === pkCol);
  if (def && def.type === 'bigint') return 'bigint';
  return 'text';
}

function mapParentRecord(record, entry, syncedAt) {
  const pkType = effectivePkType(entry);
  const idValue = resolveId(record, entry.idFields, pkType);
  if (idValue === null || idValue === undefined) return null;

  const row = { synced_at: syncedAt };
  const pkCol = pkColumnName(entry);

  let pkInColumns = false;
  for (const col of entry.columns || []) {
    if (col.name === pkCol) { pkInColumns = true; break; }
  }
  if (!pkInColumns) {
    row[pkCol] = idValue;
  }

  for (const col of entry.columns || []) {
    row[col.name] = castValue(getPath(record, col.from), col.type);
  }

  if (pkInColumns && isBlank(row[pkCol])) {
    row[pkCol] = idValue;
  }

  return { row, idValue, pkCol };
}

function mapChildRecord(record, childDef, parentIdValue, parentPkCol, syncedAt, index) {
  const pkType = effectivePkType(childDef);
  const idValue = resolveId(
    record,
    childDef.idFields,
    pkType,
    `${parentIdValue}|${index}|`
  );

  const row = {
    synced_at: syncedAt,
    [childDef.parentRefColumn || parentPkCol]: parentIdValue,
  };

  const pkCol = pkColumnName(childDef);

  let pkInColumns = false;
  for (const col of childDef.columns || []) {
    if (col.name === pkCol) { pkInColumns = true; break; }
  }
  if (!pkInColumns) {
    row[pkCol] = idValue;
  }

  for (const col of childDef.columns || []) {
    row[col.name] = castValue(getPath(record, col.from), col.type);
  }

  if (pkInColumns && isBlank(row[pkCol])) {
    row[pkCol] = idValue;
  }

  return row;
}

function extractChildRecords(parentRecord, parentIdValue, parentPkCol, entry, syncedAt, out) {
  for (const childDef of entry.children || []) {
    let list = getPath(parentRecord, childDef.listFrom);
    if (!list) continue;
    if (!Array.isArray(list)) list = [list];
    if (!out[childDef.table]) out[childDef.table] = [];
    list.forEach((rec, idx) => {
      if (rec === null || rec === undefined) return;
      const row = mapChildRecord(rec, childDef, parentIdValue, parentPkCol, syncedAt, idx);
      out[childDef.table].push(row);
    });
  }
}

function countFilledFields(row) {
  return Object.values(row).filter((v) => v !== null && v !== undefined && v !== '').length;
}

function makeTransformer(entry) {
  return (records) => {
    const syncedAt = new Date().toISOString();
    const parent = [];
    const seenParents = new Set();
    const children = {};

    for (const record of records || []) {
      if (!record || typeof record !== 'object') continue;
      const mapped = mapParentRecord(record, entry, syncedAt);
      if (!mapped) continue;

      const { row, idValue, pkCol } = mapped;
      const key = String(idValue);
      if (seenParents.has(key)) {
        const existingIdx = parent.findIndex((r) => String(r[pkCol]) === key);
        if (existingIdx >= 0) {
  const existing = parent[existingIdx];
  if (countFilledFields(row) >= countFilledFields(existing)) {
    parent[existingIdx] = row;
  }
}
      } else {
        seenParents.add(key);
        parent.push(row);
      }

      extractChildRecords(record, idValue, pkCol, entry, syncedAt, children);
    }

    return { parent, children };
  };
}

module.exports = {
  makeTransformer,
  mapParentRecord,
  mapChildRecord,
  resolveId,
  castValue,
  FALLBACK_ID_FIELDS,
  pkColumnName,
  effectivePkType,
};
