require('dotenv').config();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const OMIE_APP_KEY = process.env.OMIE_APP_KEY;
const OMIE_APP_SECRET = process.env.OMIE_APP_SECRET;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Período padrão: ano corrente inteiro. Pode passar datas customizadas:
//   node scripts/sync-cmc-vendas.js 01/01/2025 17/07/2026
const DATA_INICIAL = process.argv[2] || '01/01/2026';
const DATA_FINAL = process.argv[3] || hojeBR();

function hojeBR() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function dataBRparaISO(dataBR) {
  if (!dataBR) return null;
  const [d, m, a] = dataBR.split('/');
  return `${a}-${m}-${d}`;
}

async function buscarMovimentosProduto(codProd, tentativa = 1) {
  try {
    const { data } = await axios.post('https://app.omie.com.br/api/v1/estoque/consulta/', {
      call: 'MovimentoEstoque',
      app_key: OMIE_APP_KEY,
      app_secret: OMIE_APP_SECRET,
      param: [{
        codigo_local_estoque: 0,
        id_prod: codProd,
        cod_int: '',
        dataInicial: DATA_INICIAL,
        dataFinal: DATA_FINAL,
        tipo_movimento: '',
      }],
    });
    return data.movProduto || [];
  } catch (e) {
    const msg = e.response?.data?.faultstring || e.response?.data?.message || e.message;
    // Retry em erro transitório comum da API do Omie (rate limit / instabilidade)
    if (tentativa < 4 && (msg?.includes('Consumo redundante') || msg?.includes('Broken response') || e.response?.status === 500)) {
      await sleep(1500 * tentativa);
      return buscarMovimentosProduto(codProd, tentativa + 1);
    }
    console.log(`  FALHA produto ${codProd}: ${msg}`);
    return null; // null = falha real (diferente de [] = sem movimento)
  }
}

async function main() {
  console.log(`Período: ${DATA_INICIAL} até ${DATA_FINAL}`);

  const { data: produtos, error } = await supabase
    .from('omie_estoque_posicao')
    .select('cod_prod, codigo, descricao');
  if (error) throw error;

  console.log(`Encontrados ${produtos.length} produtos. Buscando movimentos de venda...`);

  let ok = 0, falhas = 0, semMovimento = 0, totalVendasEncontradas = 0;
  const linhasParaSalvar = [];

  for (let i = 0; i < produtos.length; i++) {
    const p = produtos[i];
    const movimentos = await buscarMovimentosProduto(p.cod_prod);

    if (movimentos === null) {
      falhas++;
    } else if (movimentos.length === 0) {
      semMovimento++;
      ok++;
    } else {
      const vendas = movimentos.filter(m => m.codOrigem === 'VEN');
      vendas.forEach(m => {
        const saida = (m.movPeriodo || []).find(mp => mp.tipo === '3.Saída');
        if (!saida || !saida.qtde) return;
        const qtdeSaida = Math.abs(Number(saida.qtde));
        const cmcUnitario = Number(saida.cmcUnitario || 0);
        linhasParaSalvar.push({
          id_mov: m.idMov,
          cod_prod: p.cod_prod,
          dt_mov: dataBRparaISO(m.dtMov),
          qtde_saida: qtdeSaida,
          cmc_unitario: cmcUnitario,
          custo: qtdeSaida * cmcUnitario,
          num_doc: m.numDoc || null,
          id_pedido: m.idPedido || null,
          cancelamento: m.cancelamento === 'S',
          devolucao: m.devolucao === 'S',
        });
      });
      totalVendasEncontradas += vendas.length;
      ok++;
    }

    if ((i + 1) % 50 === 0) {
      console.log(`  ${i + 1}/${produtos.length} produtos processados (${totalVendasEncontradas} vendas encontradas até agora)`);
    }
    await sleep(700); // evita "Consumo redundante"
  }

  console.log(`\nBusca concluída: ${ok} ok, ${falhas} falhas, ${semMovimento} sem movimento.`);
  console.log(`Total de linhas de venda a salvar: ${linhasParaSalvar.length}`);

  if (linhasParaSalvar.length === 0) {
    console.log('Nada para salvar.');
    return;
  }

  const BATCH = 500;
  let salvos = 0;
  for (let i = 0; i < linhasParaSalvar.length; i += BATCH) {
    const lote = linhasParaSalvar.slice(i, i + BATCH);
    const { error: upErr } = await supabase
      .from('omie_estoque_cmc_vendas')
      .upsert(lote, { onConflict: 'id_mov' });
    if (upErr) {
      console.log(`  ERRO ao salvar lote ${Math.floor(i / BATCH) + 1}: ${upErr.message}`);
    } else {
      salvos += lote.length;
    }
  }

  console.log(`Salvos ${salvos} de ${linhasParaSalvar.length} registros de venda.`);
}

main().catch(e => console.error('ERRO GERAL:', e.message));
