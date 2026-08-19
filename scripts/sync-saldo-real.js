require('dotenv').config();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const OMIE_APP_KEY = process.env.OMIE_APP_KEY;
const OMIE_APP_SECRET = process.env.OMIE_APP_SECRET;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function hojeBR() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const { data: contas, error } = await supabase
    .from('omie_current_accounts')
    .select('omie_id, cod_cc, descricao')
    .eq('inativo', false);
  if (error) throw error;

  console.log(`Encontradas ${contas.length} contas ativas. Buscando saldo real via ListarExtrato...`);

  const hoje = hojeBR();
  let ok = 0, falhas = 0;

  for (const conta of contas) {
    try {
      const { data } = await axios.post('https://app.omie.com.br/api/v1/financas/extrato/', {
        call: 'ListarExtrato',
        app_key: OMIE_APP_KEY,
        app_secret: OMIE_APP_SECRET,
        param: [{ nCodCC: conta.cod_cc, dPeriodoInicial: hoje, dPeriodoFinal: hoje }],
      });

      const { error: upErr } = await supabase
        .from('omie_current_accounts')
        .update({
          saldo_atual: data.nSaldoAtual,
          saldo_disponivel: data.nSaldoDisponivel,
          saldo_atualizado_em: new Date().toISOString(),
        })
        .eq('omie_id', conta.omie_id);
      if (upErr) throw upErr;

      console.log(`  OK: ${conta.descricao} (${conta.cod_cc}) = R$ ${data.nSaldoAtual}`);
      ok++;
    } catch (e) {
      console.log(`  FALHA: ${conta.descricao} (${conta.cod_cc}) -> ${e.response?.data?.faultstring || e.message}`);
      falhas++;
    }
    await sleep(700); // evita "consumo redundante"
  }

  console.log(`\nConcluído: ${ok} ok, ${falhas} falhas.`);
}

main().catch(e => console.error('ERRO GERAL:', e.message));
