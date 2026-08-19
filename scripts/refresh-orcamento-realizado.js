require('dotenv').config();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const EMPRESA_ID = 'KMNO';
const OMIE_APP_KEY = process.env.OMIE_APP_KEY;
const OMIE_APP_SECRET = process.env.OMIE_APP_SECRET;
const supabaseDash = createClient(process.env.DASHBOARD_SUPABASE_URL, process.env.DASHBOARD_SUPABASE_SERVICE_ROLE_KEY);
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function* mesesEntre(anoIni, mesIni, anoFim, mesFim) {
  let a = anoIni, m = mesIni;
  while (a < anoFim || (a === anoFim && m <= mesFim)) {
    yield { ano: a, mes: m };
    m++; if (m > 12) { m = 1; a++; }
  }
}
async function chamarOmieComRetry(ano, mes, tentativa = 1) {
  try {
    const { data } = await axios.post('https://app.omie.com.br/api/v1/financas/caixa/', {
      call: 'ListarOrcamentos',
      app_key: OMIE_APP_KEY,
      app_secret: OMIE_APP_SECRET,
      param: [{ nAno: ano, nMes: mes }],
    });
    return data;
  } catch (e) {
    const msg = e.response?.data?.faultstring || '';
    const redundante = /consumo redundante/i.test(msg);
    if (redundante && tentativa <= 3) {
      const match = msg.match(/(\d+)\s*segundos/i);
      const esperaSeg = match ? parseInt(match[1], 10) : 35;
      console.log(`[${EMPRESA_ID}] ${mes}/${ano}: Consumo redundante, aguardando ${esperaSeg}s (tentativa ${tentativa}/3)...`);
      await sleep((esperaSeg + 2) * 1000);
      return chamarOmieComRetry(ano, mes, tentativa + 1);
    }
    throw e;
  }
}
async function refrescarMes(ano, mes) {
  const data = await chamarOmieComRetry(ano, mes);
  const linhas = data.ListaOrcamentos || [];
  const folhas = linhas.filter(l => l.cCodCateg.split('.').length >= 3);
  const rows = folhas.map(l => ({
    empresa_id: EMPRESA_ID, ano, mes,
    cod_categoria: l.cCodCateg,
    valor_realizado: l.nValorRealizado,
  }));
  if (rows.length) {
    const { error } = await supabaseDash
      .from('dash_orcamento_realizado_categoria')
      .upsert(rows, { onConflict: 'empresa_id,ano,mes,cod_categoria' });
    if (error) throw error;
  }
  const receitas = linhas.find(l => l.cCodCateg === '1');
  const despesas = linhas.find(l => l.cCodCateg === '2');
  if (receitas || despesas) {
    const { error: err2 } = await supabaseDash
      .from('dash_orcamento_realizado')
      .upsert({
        empresa_id: EMPRESA_ID, ano, mes,
        receitas_realizado: receitas ? receitas.nValorRealizado : null,
        despesas_realizado: despesas ? despesas.nValorRealizado : null,
      }, { onConflict: 'empresa_id,ano,mes' });
    if (err2) throw err2;
  }
  console.log(`[${EMPRESA_ID}] ${mes}/${ano}: ${rows.length} categorias | Receitas=${receitas?.nValorRealizado} Despesas=${despesas?.nValorRealizado}`);
}
async function main() {
  const args = process.argv.slice(2).map(Number);
  const hoje = new Date();
  const [anoIni, mesIni, anoFim, mesFim] = args.length === 4
    ? args
    : [hoje.getFullYear(), hoje.getMonth() + 1, hoje.getFullYear(), hoje.getMonth() + 1];
  for (const { ano, mes } of mesesEntre(anoIni, mesIni, anoFim, mesFim)) {
    try { await refrescarMes(ano, mes); } catch (e) { console.error(`FALHA ${mes}/${ano}:`, e.response?.data || e.message); }
    await sleep(600);
  }
}
main();
