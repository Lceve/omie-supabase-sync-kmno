#!/usr/bin/env node
'use strict';

// Pedido 12/08/2026 (Lucas): o financeiro antecipa boletos com
// frequência (move dt_pagamento 1-2 meses pra trás). O Omie filtra
// ListarMovimentos por dDtPagtoDe/dDtPagtoAte -- então quando a data
// muda pra fora da janela do sync incremental (poucas horas, entre um
// sync de 3h e outro), o título nunca mais é re-buscado e fica com a
// data antiga pra sempre.
//
// Este script força um re-fetch de uma janela ROLANTE fixa (default
// 120 dias / ~4 meses) pra trás, sempre a partir de hoje -- não
// depende do último sync bem-sucedido. Upsert é por cod_titulo (PK),
// então re-processar NÃO duplica -- só corrige a linha existente.
//
// Uso: node scripts/backfill-rolling.js [dias] [entidade]
//   dias      default 120
//   entidade  default financial_movements
//
// Pensado pra rodar 1x/dia via cron, separado do sync incremental de
// 3h (que continua rápido/leve, sem essa janela larga).

require('dotenv').config();
const { getEntities } = require('../src/entities');
const { upsert } = require('../src/loader');
const { writeLog } = require('../src/syncLog');
const { pkColumnName } = require('../src/transformers/generic');
const logger = require('../src/logger');

const DIAS = parseInt(process.argv[2] || '120', 10);
const ENTIDADE = process.argv[3] || 'financial_movements';

async function main() {
  const since = new Date(Date.now() - DIAS * 86400000);
  const entity = getEntities().find((e) => e.name === ENTIDADE);
  if (!entity) {
    console.error(`Entidade "${ENTIDADE}" nao encontrada.`);
    console.error('Disponiveis: ' + getEntities().map((e) => e.name).join(', '));
    process.exit(1);
  }

  const startedAt = new Date().toISOString();
  console.log(`=== Backfill rolante: ${entity.name} (${DIAS} dias, desde ${since.toISOString()}) ===`);

  try {
    const raw = await entity.extract(since);
    console.log(`Extraidos ${raw.length} registros`);

    const { parent, children } = entity.transform(raw);
    const parentPk = pkColumnName(entity.entry);
    const validParent = parent.filter((r) => r[parentPk] !== null && r[parentPk] !== undefined);
    await upsert(entity.table, validParent, parentPk);

    let childTotal = 0;
    for (const childDef of entity.entry.children || []) {
      const list = children[childDef.table] || [];
      if (!list.length) continue;
      const pk = pkColumnName(childDef);
      const fk = childDef.parentRefColumn || parentPk;
      const validChildren = list.filter((r) => r[pk] !== null && r[pk] !== undefined);
      childTotal += validChildren.length;
      const conflict = fk !== pk ? `${fk},${pk}` : pk;
      await upsert(childDef.table, validChildren, conflict);
    }

    await writeLog({
      entity: entity.name,
      recordsSynced: validParent.length + childTotal,
      startedAt,
      status: 'success',
    });

    console.log(`OK -- ${validParent.length} registros pai + ${childTotal} filhos atualizados`);
    process.exit(0);
  } catch (err) {
    logger.error(`Backfill rolante falhou: ${entity.name}`, { error: err.message });
    await writeLog({
      entity: entity.name,
      recordsSynced: 0,
      startedAt,
      status: 'error',
      error: err.message,
    });
    console.error(err);
    process.exit(1);
  }
}

main();
