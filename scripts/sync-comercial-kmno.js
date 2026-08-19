#!/usr/bin/env node
'use strict';

// ===================================================================
// sync-comercial-kmno.js
//
// Backfill + sync recorrente dos dados COMERCIAIS da KMNO (pedidos,
// itens de pedido, produtos, vendedores) do Supabase da KMNO
// (enedbeguahicctwwhpmb) pro banco consolidado do dashboard
// (ihekejwxdvipgldblskn) — tabelas dash_orders, dash_order_items,
// dash_products, dash_vendedores.
//
// Por que esse script existe: o dashboard (index.html) só se conecta
// ao banco consolidado, que até agora só tinha dado financeiro
// (dash_financial_movements etc). Pedidos/produtos/vendedores nunca
// tinham sido trazidos pra lá.
//
// USO:
//   1. Cria um arquivo .env nesta mesma pasta (ver .env.example abaixo)
//   2. npm install @supabase/supabase-js dotenv
//   3. node sync-comercial-kmno.js
//
// Rodar de novo a qualquer momento é seguro — usa upsert (ON CONFLICT
// DO UPDATE) pela chave (empresa_id, codigo_pedido/codigo/etc), então
// nunca duplica linha, só atualiza.
// ===================================================================

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const EMPRESA_ID = 'KMNO';
const PAGE_SIZE = 1000;
const UPSERT_BATCH_SIZE = 500;

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`ERRO: variável de ambiente ${name} não definida. Veja o .env.example no topo do arquivo.`);
    process.exit(1);
  }
  return v;
}

// Fonte: Supabase da KMNO (schema omie_*)
const sourceClient = createClient(
  requireEnv('KMNO_SUPABASE_URL'),
  requireEnv('KMNO_SUPABASE_SERVICE_ROLE_KEY')
);

// Destino: Supabase consolidado do dashboard (schema dash_*)
const targetClient = createClient(
  requireEnv('DASHBOARD_SUPABASE_URL'),
  requireEnv('DASHBOARD_SUPABASE_SERVICE_ROLE_KEY')
);

// Puxa TODAS as linhas de uma tabela fonte, paginando de verdade (o
// PostgREST limita a 1000 linhas por request por padrão — sem isso,
// tabelas grandes (ex: omie_order_items com ~18k linhas) truncariam
// silenciosamente).
async function fetchAllRows(client, table, columns) {
  let all = [];
  let from = 0;
  while (true) {
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await client.from(table).select(columns).range(from, to);
    if (error) throw new Error(`Erro lendo ${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    all = all.concat(data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

// Upsert em lotes (evita payload gigante numa request só).
async function upsertInBatches(client, table, rows, conflictCols) {
  let total = 0;
  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + UPSERT_BATCH_SIZE);
    const { error } = await client.from(table).upsert(batch, { onConflict: conflictCols });
    if (error) throw new Error(`Erro gravando em ${table} (lote ${i}-${i + batch.length}): ${error.message}`);
    total += batch.length;
    process.stdout.write(`\r  ${table}: ${total}/${rows.length} gravados`);
  }
  console.log('');
  return total;
}

async function syncOrders() {
  console.log('→ Lendo omie_orders (KMNO)...');
  const rows = await fetchAllRows(
    sourceClient,
    'omie_orders',
    'codigo_pedido,codigo_cliente,codigo_vendedor,etapa,origem_pedido,valor_total_pedido,valor_descontos,valor_mercadorias,info_dt_inc,data_previsao,cancelado,faturado,denegado,devolvido,autorizado'
  );
  console.log(`  ${rows.length} pedidos encontrados na origem.`);

  const transformed = rows.map(r => ({
    empresa_id: EMPRESA_ID,
    codigo_pedido: r.codigo_pedido,
    codigo_cliente: r.codigo_cliente,
    codigo_vendedor: r.codigo_vendedor,
    etapa: r.etapa,
    origem_pedido: r.origem_pedido,
    valor_total_pedido: r.valor_total_pedido,
    valor_descontos: r.valor_descontos,
    valor_mercadorias: r.valor_mercadorias,
    data_pedido: r.info_dt_inc,
    data_previsao: r.data_previsao,
    cancelado: r.cancelado,
    faturado: r.faturado,
    denegado: r.denegado,
    devolvido: r.devolvido,
    autorizado: r.autorizado,
  }));

  await upsertInBatches(targetClient, 'dash_orders', transformed, 'empresa_id,codigo_pedido');
}

async function syncOrderItems() {
  console.log('→ Lendo omie_order_items (KMNO)...');
  const rows = await fetchAllRows(
    sourceClient,
    'omie_order_items',
    'codigo_pedido,codigo_item,codigo_produto,quantidade,valor_unitario,valor_desconto,percentual_desconto,valor_total'
  );
  console.log(`  ${rows.length} itens de pedido encontrados na origem.`);

  const transformed = rows.map(r => ({
    empresa_id: EMPRESA_ID,
    codigo_pedido: r.codigo_pedido,
    codigo_item: r.codigo_item,
    codigo_produto: r.codigo_produto,
    quantidade: r.quantidade,
    valor_unitario: r.valor_unitario,
    valor_desconto: r.valor_desconto,
    percentual_desconto: r.percentual_desconto,
    valor_total: r.valor_total,
  }));

  await upsertInBatches(targetClient, 'dash_order_items', transformed, 'empresa_id,codigo_pedido,codigo_item');
}

async function syncProducts() {
  console.log('→ Lendo omie_products (KMNO)...');
  const rows = await fetchAllRows(
    sourceClient,
    'omie_products',
    'codigo_produto,descricao,codigo_familia,descricao_familia,inativo'
  );
  console.log(`  ${rows.length} produtos encontrados na origem.`);

  const transformed = rows.map(r => ({
    empresa_id: EMPRESA_ID,
    codigo_produto: r.codigo_produto,
    descricao: r.descricao,
    codigo_familia: r.codigo_familia,
    descricao_familia: r.descricao_familia,
    inativo: r.inativo,
  }));

  await upsertInBatches(targetClient, 'dash_products', transformed, 'empresa_id,codigo_produto');
}

async function syncVendedores() {
  console.log('→ Lendo omie_vendedores (KMNO)...');
  const rows = await fetchAllRows(sourceClient, 'omie_vendedores', 'codigo,nome');
  console.log(`  ${rows.length} vendedores encontrados na origem.`);

  const transformed = rows.map(r => ({
    empresa_id: EMPRESA_ID,
    codigo: r.codigo,
    nome: r.nome,
  }));
  // "Sem vendedor" (código 0) — usado quando codigo_vendedor vem 0/null no pedido.
  transformed.push({ empresa_id: EMPRESA_ID, codigo: 0, nome: 'Sem vendedor' });

  await upsertInBatches(targetClient, 'dash_vendedores', transformed, 'empresa_id,codigo');
}

async function main() {
  console.log('=== Sync Comercial KMNO → Dashboard Consolidado ===');
  console.log(`Início: ${new Date().toISOString()}\n`);

  try {
    await syncVendedores();
    await syncProducts();
    await syncOrders();
    await syncOrderItems();
    console.log('\n✅ Sync concluído com sucesso.');
  } catch (err) {
    console.error('\n❌ Sync falhou:', err.message);
    process.exit(1);
  }
}

main();

// ===================================================================
// .env.example (crie um arquivo .env real na mesma pasta com esses
// valores preenchidos — NÃO commitar o .env de verdade no git):
//
// KMNO_SUPABASE_URL=https://enedbeguahicctwwhpmb.supabase.co
// KMNO_SUPABASE_SERVICE_ROLE_KEY=<mesma service role key já usada no omie-supabase-sync-KMNO>
// DASHBOARD_SUPABASE_URL=https://ihekejwxdvipgldblskn.supabase.co
// DASHBOARD_SUPABASE_SERVICE_ROLE_KEY=<service role key do projeto consolidado>
// ===================================================================
