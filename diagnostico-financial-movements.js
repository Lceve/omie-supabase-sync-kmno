// Diagnóstico — mostra o JSON completo e bruto de alguns registros do
// endpoint financas/mf (ListarMovimentos), pra comparar contra o mapeamento
// esperado em config/omie-tables.js (entrada 'financial_movements').
//
// O mapeamento atual espera a forma:
//   { detalhes: { nCodTitulo, cNatureza, cTipo, cStatus, nValorTitulo, ... },
//     resumo: { cLiquidado, nValPago, ... },
//     boleto: { ... },
//     departamentos: { ... } }
//
// Se o JSON real vier diferente disso (outros nomes de campo, outra
// estrutura, ou tipo/valor em outro lugar), este script vai mostrar
// exatamente onde a divergência está.
//
// Uso: node diagnostico-financial-movements.js
// Rodar com as envs do KMNO configuradas (OMIE_APP_KEY, OMIE_APP_SECRET
// apontando pra chave de integração da KMNO no Omie).

require('dotenv').config();
const axios = require('axios');

async function main() {
  const appKey = process.env.OMIE_APP_KEY;
  const appSecret = process.env.OMIE_APP_SECRET;
  const baseUrl = process.env.OMIE_BASE_URL || 'https://app.omie.com.br/api/v1';

  if (!appKey || !appSecret) {
    console.error('Faltando OMIE_APP_KEY / OMIE_APP_SECRET no ambiente.');
    process.exit(1);
  }

  // Janela de datas — o endpoint costuma exigir um período (dDtPagtoDe /
  // dDtPagtoAte no formato DD/MM/YYYY). Pegamos os últimos 90 dias.
  const hoje = new Date();
  const inicio = new Date(hoje.getTime() - 90 * 24 * 60 * 60 * 1000);
  const fmt = (d) => {
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  };

  console.log(`Consultando financas/mf (ListarMovimentos) de ${fmt(inicio)} a ${fmt(hoje)}...`);

  const { data } = await axios.post(`${baseUrl}/financas/mf/`, {
    call: 'ListarMovimentos',
    app_key: appKey,
    app_secret: appSecret,
    param: [{
      nPagina: 1,
      nRegPorPagina: 5,
      dDtPagtoDe: fmt(inicio),
      dDtPagtoAte: fmt(hoje),
    }],
  });

  if (data.faultstring) {
    console.error('Erro Omie:', data.faultcode, data.faultstring);
    process.exit(1);
  }

  console.log('\n=== Chaves de topo da resposta ===');
  console.log(Object.keys(data));

  const registros = data.movimentos || data.listaMovimentos || null;
  if (!registros) {
    console.log('\n⚠️  Não achei "movimentos" nem "listaMovimentos" no topo.');
    console.log('Resposta completa (JSON):');
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.log(`\n=== ${registros.length} registro(s) encontrados. Mostrando JSON completo de até 3: ===`);
  registros.slice(0, 3).forEach((r, i) => {
    console.log(`\n--- Registro ${i + 1} ---`);
    console.log(JSON.stringify(r, null, 2));
  });

  // Checagem específica: o código espera r.detalhes.nValorTitulo e
  // r.detalhes.cTipo. Vamos ver se esses caminhos existem de fato.
  console.log('\n=== Checagem dos campos esperados pelo mapeamento atual ===');
  registros.slice(0, 3).forEach((r, i) => {
    console.log(`Registro ${i + 1}:`);
    console.log('  tem "detalhes"?', 'detalhes' in r);
    console.log('  detalhes.nValorTitulo =', r?.detalhes?.nValorTitulo);
    console.log('  detalhes.cTipo =', r?.detalhes?.cTipo);
    console.log('  detalhes.cNatureza =', r?.detalhes?.cNatureza);
    console.log('  detalhes.cStatus =', r?.detalhes?.cStatus);
    console.log('  chaves de nível superior do registro:', Object.keys(r));
  });
}

main().catch(err => {
  console.error('Falha:', err.response?.data || err.message);
  process.exit(1);
});
