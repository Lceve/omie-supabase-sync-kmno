// sync-saldo-mensal.js — busca o saldo OFICIAL do Omie (ListarExtrato,
// cExibirApenasSaldo=S) no dia 1 de um mês, por conta (só fluxo_caixa=true),
// e grava no projeto CONSOLIDADO (dash_saldo_bancario_mensal). Substitui o
// rollback client-side (saldoBancosPorContaRollback) que tinha bug pra
// contas de giro alto (Omie.CASH etc.) — decisão 11/08/2026.
//
// Uso:
//   node sync-saldo-mensal.js                -> mês atual (dia 1)
//   node sync-saldo-mensal.js 2026 6 2026 8   -> intervalo (ano/mes inicial, ano/mes final), inclusive
//
// Roda 1x/mês via cron (dia 1 ou 2), reaproveitando .env já existente
// (OMIE_APP_KEY/SECRET, SUPABASE_URL/SERVICE_KEY = projeto FONTE da
// empresa, DASHBOARD_SUPABASE_URL/SERVICE_ROLE_KEY = projeto consolidado).
require('dotenv').config();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const EMPRESA_ID = 'KMNO'; // <-- único ponto que muda entre os 3 repos (KMNO/RT/NOVAH)

const OMIE_APP_KEY = process.env.OMIE_APP_KEY;
const OMIE_APP_SECRET = process.env.OMIE_APP_SECRET;
const supabaseFonte = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const supabaseDash = createClient(process.env.DASHBOARD_SUPABASE_URL, process.env.DASHBOARD_SUPABASE_SERVICE_ROLE_KEY);

function paraDataBr(d) {
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function saldoNoDia1(nCodCC, ano, mes) {
  const alvo = new Date(ano, mes - 1, 1); // mes 1-indexado na chamada, Date usa 0-indexado
  const inicio = new Date(alvo.getTime() - 89 * 24 * 60 * 60 * 1000);
  const { data } = await axios.post('https://app.omie.com.br/api/v1/financas/extrato/', {
    call: 'ListarExtrato',
    app_key: OMIE_APP_KEY,
    app_secret: OMIE_APP_SECRET,
    param: [{
      nCodCC,
      dPeriodoInicial: paraDataBr(inicio),
      dPeriodoFinal: paraDataBr(alvo),
      cExibirApenasSaldo: 'S',
    }],
  });
  return data.nSaldoAtual;
}

function* mesesEntre(anoIni, mesIni, anoFim, mesFim) {
  let a = anoIni, m = mesIni;
  while (a < anoFim || (a === anoFim && m <= mesFim)) {
    yield { ano: a, mes: m };
    m++; if (m > 12) { m = 1; a++; }
  }
}

async function main() {
  const args = process.argv.slice(2).map(Number);
  const hoje = new Date();
  const [anoIni, mesIni, anoFim, mesFim] = args.length === 4
    ? args
    : [hoje.getFullYear(), hoje.getMonth() + 1, hoje.getFullYear(), hoje.getMonth() + 1];

  const { data: contasRaw, error } = await supabaseDash
    .from('dash_contas_correntes')
    .select('n_cod_cc, descricao, fluxo_caixa')
    .eq('empresa_id', EMPRESA_ID)
    .eq('fluxo_caixa', true);
  if (error) throw error;
  const contas = contasRaw.map(c => ({ cod_cc: c.n_cod_cc, descricao: c.descricao }));
  console.log(`[${EMPRESA_ID}] ${contas.length} contas fluxo_caixa=true (fonte: dash_contas_correntes do consolidado).`);

  for (const { ano, mes } of mesesEntre(anoIni, mesIni, anoFim, mesFim)) {
    console.log(`\n=== ${EMPRESA_ID} ${mes}/${ano} (saldo dia 1) ===`);
    for (const conta of contas) {
      try {
        const saldo = await saldoNoDia1(conta.cod_cc, ano, mes);
        const { error: upErr } = await supabaseDash
          .from('dash_saldo_bancario_mensal')
          .upsert({
            empresa_id: EMPRESA_ID,
            cod_cc: conta.cod_cc,
            descricao: conta.descricao,
            ano, mes,
            saldo_dia1: saldo,
            synced_at: new Date().toISOString(),
          }, { onConflict: 'empresa_id,cod_cc,ano,mes' });
        if (upErr) throw upErr;
        console.log(`  OK: ${conta.descricao} (${conta.cod_cc}) = R$ ${saldo}`);
      } catch (e) {
        console.log(`  FALHA: ${conta.descricao} (${conta.cod_cc}) -> ${e.response?.data?.faultstring || e.message}`);
      }
      await sleep(700);
    }
  }
  console.log('\nConcluído.');
}

main().catch(e => console.error('ERRO GERAL:', e.message));
