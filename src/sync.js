'use strict';

const { getEntities } = require('./entities');
const { upsert } = require('./loader');
const { writeLog, getLastSync } = require('./syncLog');
const { pkColumnName } = require('./transformers/generic');
const logger = require('./logger');

/**
 * Sync one entity. If `full` is false, tries incremental sync using
 * the timestamp of the last successful run for that entity.
 */
async function syncEntity(entity, full = false) {
  const startedAt = new Date().toISOString();
  logger.info(`Starting sync: ${entity.name}`, { full });

  let since = null;
  if (!full) {
    since = await getLastSync(entity.name);
    if (since) logger.info(`Incremental sync since ${since.toISOString()}`, { entity: entity.name });
  }

  try {
    const raw = await entity.extract(since, full);
    logger.info(`Extracted ${raw.length} records`, { entity: entity.name });

    const { parent, children } = entity.transform(raw);

    // Parent upsert
    const parentPk = pkColumnName(entity.entry);
    // Filter out rows with null PK (couldn't resolve an ID)
    const validParent = parent.filter((r) => r[parentPk] !== null && r[parentPk] !== undefined);
    const skipped = parent.length - validParent.length;
    if (skipped) {
      logger.warn(`Dropped ${skipped} ${entity.name} record(s) with null primary key`, {
        entity: entity.name,
        pk: parentPk,
      });
    }
    await upsert(entity.table, validParent, parentPk);

    // Child upserts (in declaration order so FK targets exist)
    let childTotal = 0;
    for (const childDef of entity.entry.children || []) {
      const list = children[childDef.table] || [];
      if (!list.length) continue;
      const pk = pkColumnName(childDef);
      const fk = childDef.parentRefColumn || parentPk;
      const validChildren = list.filter((r) => r[pk] !== null && r[pk] !== undefined);
      childTotal += validChildren.length;
      // Composite conflict target when the child has a (fk, pk) PK.
      const conflict = fk !== pk ? `${fk},${pk}` : pk;
      await upsert(childDef.table, validChildren, conflict);
    }

    await writeLog({
      entity: entity.name,
      recordsSynced: validParent.length + childTotal,
      startedAt,
      status: 'success',
    });

    logger.info(`Finished sync: ${entity.name}`, {
      parent: validParent.length,
      children: childTotal,
    });
    return {
      entity: entity.name,
      count: validParent.length,
      children: childTotal,
      status: 'success',
    };
  } catch (err) {
    logger.error(`Sync failed: ${entity.name}`, { error: err.message });

    await writeLog({
      entity: entity.name,
      recordsSynced: 0,
      startedAt,
      status: 'error',
      error: err.message,
    });

    return { entity: entity.name, count: 0, status: 'error', error: err.message };
  }
}

/**
 * Run all entities sequentially.
 * @param {boolean} full - if true, ignore last-sync timestamp (full re-sync)
 * @param {string[]} only - if provided, only sync these entity names
 */
async function runSync(full = false, only = []) {
  const entities = getEntities();
  const targets = only.length
    ? entities.filter((e) => only.includes(e.name))
    : entities;

  if (only.length && targets.length !== only.length) {
    const missing = only.filter((n) => !targets.find((t) => t.name === n));
    if (missing.length) {
      logger.warn('Unknown entity names skipped', { missing });
    }
  }

  logger.info(`=== Sync started (${full ? 'FULL' : 'incremental'}) ===`, {
    entities: targets.map((e) => e.name),
  });

  const results = [];
  for (const entity of targets) {
    const result = await syncEntity(entity, full);
    results.push(result);
  }

  const ok = results.filter((r) => r.status === 'success').length;
  const fail = results.filter((r) => r.status === 'error').length;
  logger.info(`=== Sync complete: ${ok} ok, ${fail} failed ===`);

  return results;
}

module.exports = { runSync, syncEntity };

if (require.main === module) {
  require('dotenv').config();
  const full = process.argv.includes('--full');
  runSync(full).then(() => process.exit(0)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
