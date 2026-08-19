'use strict';

/**
 * Registry-driven entity builder.
 *
 * Every Omie endpoint — legacy hand-tuned ones included — lives in
 * `config/omie-tables.js`. A single generic extractor + transformer
 * turns each entry into a complete ETL pipeline at runtime; no
 * per-table code is needed.
 *
 * The 8 phase-0 entries flagged `legacy: true` keep their bespoke
 * extractor wrappers (clients/orders/finance/services/products/crm)
 * because they use specific Omie API call signatures and a custom
 * `since` field strategy. Their schema and field mapping however is
 * driven entirely by the registry.
 */

const { makeExtractor } = require('./extractors/generic');
const { makeTransformer } = require('./transformers/generic');
const extractClients = require('./extractors/clients');
const extractOrders = require('./extractors/orders');
const extractServices = require('./extractors/services');
const extractProducts = require('./extractors/products');
const { extractReceivable, extractPayable } = require('./extractors/finance');
const { extractOpportunities, extractActivities } = require('./extractors/crm');
const { activeTables } = require('../config/omie-tables');

// Override map: legacy entries use a bespoke extractor signature instead
// of the registry's generic one. Everything else (transformer, schema,
// column mapping) comes from the registry.
const LEGACY_EXTRACTORS = {
  clients:           extractClients,
  orders:            extractOrders,
  services:          extractServices,
  products:          extractProducts,
  receivable:        extractReceivable,
  payable:           extractPayable,
  crm_opportunities: extractOpportunities,
  crm_activities:    extractActivities,
};

function entityFromEntry(entry) {
  const extractor = LEGACY_EXTRACTORS[entry.name] || makeExtractor(entry);
  const transform = makeTransformer(entry);
  return {
    name: entry.name,
    table: entry.table,
    tier: entry.tier,
    phase: entry.phase,
    purpose: entry.purpose,
    legacy: !!entry.legacy,
    entry,
    extract: (since, full) => extractor(since, full),
    transform,
  };
}

function getEntities() {
  return activeTables().map(entityFromEntry);
}

const ENTITIES = getEntities();
module.exports = ENTITIES;
module.exports.getEntities = getEntities;
module.exports.entityFromEntry = entityFromEntry;
