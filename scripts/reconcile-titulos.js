#!/usr/bin/env node
'use strict';
require('dotenv').config();
const { call } = require('../src/omieClient');
const supabase = require('../src/supabaseClient');
const logger = require('../src/logger');

const DRY_RUN = process.argv.includes('--dry-run');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;
const recentArg = process.argv.find((a) => a.startsWith('--recent-days='));
const RECENT_DAYS = recentArg ? parseInt(recentArg.split('=')[1], 10) : null;
const TABLE = 'omie_financial_movements';
const CONCURRENCY = 1;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chaveVerdade(movimento) {
  const det = movimento.detalhes || {};
  const res = movimento.resumo || {};
  const parts = [det.nCodTitulo, det.cOrigem, det.dDtPagamento, res.nValPago]
    .filter((p) => p !== null && p !== undefined && p !== '');
  return parts.map((p) => String(p)).join('|');
}

async function buscarMovimentosDoTitulo(nCodTitulo) {
  const movimentos = [];
  let pagina = 1;
  let totalPaginas = 1;
  do {
    const r = await call('financas/mf', 'ListarMovimentos', {
      nCodTitulo,
      nPagina: pagina,
      nRegPorPagina: 50,
    });
    if (Array.isArray(r.movimentos)) movimentos.push(...r.movimentos);
    totalPaginas = r.nTotPaginas || 1;
    pagina++;
  } while (pagina <= totalPaginas);
  return movimentos;
}

async function buscarTodasLinhas() {
  const porTitulo = new Map();
  const maisRecentePorTitulo = new Map();
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data: rows, error } = await supabase
      .from(TABLE)
      .select('cod_titulo,omie_id,dt_pagamento')
      .not('cod_titulo', 'is', null).neq('cod_titulo', 0)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Erro buscando linhas: ${error.message}`);
    if (!rows || rows.length === 0) break;
    for (const r of rows) {
      if (!porTitulo.has(r.cod_titulo)) porTitulo.set(r.cod_titulo, []);
      porTitulo.get(r.cod_titulo).push(r.omie_id);
      const atual = maisRecentePorTitulo.get(r.cod_titulo);
      if (r.dt_pagamento && (!atual || r.dt_pagamento > atual)) {
        maisRecentePorTitulo.set(r.cod_titulo, r.dt_pagamento);
      }
    }
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return { porTitulo, maisRecentePorTitulo };
}

async function pool(items, n, worker) {
  const results = [];
  let idx = 0;
  async function runOne() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, runOne));
  return results;
}

async function main() {
  console.log(`=== Reconciliação de títulos (${DRY_RUN ? 'DRY RUN' : 'REAL'}) ===`);

  const { porTitulo, maisRecentePorTitulo } = await buscarTodasLinhas();
  let candidatos = [...porTitulo.entries()].filter(([, ids]) => ids.length > 1).map(([t]) => t);
  console.log(`Títulos com 2+ linhas guardadas: ${candidatos.length}`);

  if (RECENT_DAYS) {
    const corte = new Date(Date.now() - RECENT_DAYS * 86400000).toISOString().slice(0, 10);
    candidatos = candidatos.filter((t) => (maisRecentePorTitulo.get(t) || '') >= corte);
    console.log(`(--recent-days=${RECENT_DAYS} aplicado: ${candidatos.length} títulos com dt_pagamento >= ${corte})`);
  }
  if (LIMIT) {
    candidatos = candidatos.slice(0, LIMIT);
    console.log(`(--limit aplicado: processando só ${candidatos.length})`);
  }

  let totalApagadas = 0;
  let titulosLimpos = 0;
  let erros = 0;
  const todasFantasmas = [];
  let processados = 0;

  await pool(candidatos, CONCURRENCY, async (titulo) => {
    try {
      const movimentos = await buscarMovimentosDoTitulo(titulo);
      const chavesVerdade = new Set(movimentos.map(chaveVerdade));
      const idsGuardados = porTitulo.get(titulo) || [];
      const fantasmas = idsGuardados.filter((id) => !chavesVerdade.has(id));

      if (fantasmas.length > 0) {
        console.log(`  Título ${titulo}: ${fantasmas.length} fantasma -> ${fantasmas.join(', ')}`);
        todasFantasmas.push(...fantasmas);
        totalApagadas += fantasmas.length;
        titulosLimpos++;
      }
    } catch (err) {
      erros++;
      logger.error(`Reconciliação falhou pro título ${titulo}`, { error: err.message });
    }
    processados++;
    if (processados % 50 === 0) console.log(`  ... ${processados}/${candidatos.length} processados`);
  });

  if (!DRY_RUN && todasFantasmas.length > 0) {
    console.log(`Apagando ${todasFantasmas.length} linhas fantasma em lotes...`);
    const BATCH = 200;
    for (let i = 0; i < todasFantasmas.length; i += BATCH) {
      const lote = todasFantasmas.slice(i, i + BATCH);
      const { error } = await supabase.from(TABLE).delete().in('omie_id', lote);
      if (error) {
        erros++;
        logger.error('Erro apagando lote de fantasmas', { error: error.message });
      }
    }
  }

  console.log(`=== Fim: ${titulosLimpos} títulos com fantasma, ${totalApagadas} linhas ${DRY_RUN ? '(seriam apagadas)' : 'apagadas'}, ${erros} erros ===`);
  process.exit(erros > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
