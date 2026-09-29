import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { loadConfig } from "../src/config.js";
import { ChainService, deploymentKey } from "../src/services/chain-service.js";
import { IndexerService } from "../src/services/indexer-service.js";
import { z } from "zod";
const config = loadConfig();
const chain = new ChainService(config.MONAD_TESTNET_RPC_URL);
const indexer = new IndexerService(config.ENVIO_GRAPHQL_URL, config.ENVIO_HASURA_ADMIN_SECRET);
const db = new Pool({ connectionString: config.DATABASE_URL });
try {
  const anchor = await chain.anchor();
  const freshness = await indexer.freshness(anchor.number);
  assert.notEqual(freshness.status, "unavailable", "GraphQL metadata must be available");
  const projected = await indexer.query(`query($deployment:String!){ChainOrder(where:{deployment:{_eq:$deployment}},order_by:{orderId:asc},limit:50){orderId buyer seller requestId state price token}}`,
    { deployment: deploymentKey }, z.object({ ChainOrder: z.array(z.object({ orderId: z.string(), buyer: z.string(), seller: z.string(), requestId: z.string(), state: z.number(), price: z.string(), token: z.string() })) }));
  assert.ok(projected.ChainOrder.length >= 2, "Expected Phase 3 live acceptance orders");
  const evidence = [];
  for (const row of projected.ChainOrder) {
    const current = await chain.order(row.orderId);
    assert.equal(current.order.state, row.state);
    assert.equal(current.order.terms.price, row.price);
    assert.equal(current.order.buyer, row.buyer);
    assert.equal(current.order.seller, row.seller);
    assert.equal(current.order.requestId, row.requestId);
    const productKey = `${deploymentKey}:${current.order.seller}:${current.order.productKey}`;
    const sale = (await indexer.products([productKey])).get(productKey);
    const configuration = await chain.configuration(current.order.seller, current.order.productKey);
    assert.equal(sale?.terms.price, configuration.terms.price);
    assert.equal(sale?.terms.token.toLowerCase(), configuration.terms.token.toLowerCase());
    const recovery = await chain.recover(row.buyer, row.requestId);
    assert.equal(recovery.status, "finalized");
    const ids = await indexer.orders(row.buyer, "buyer", "0", 50);
    assert.ok(ids.includes(row.orderId));
    const history = await indexer.history(row.orderId, "0", 50);
    assert.ok(history.some(event => event.name === "Purchased"));
    assert.ok(history.some(event => event.name === "Settled"));
    assert.equal(new Set(history.map(event => event.id)).size, history.length);
    const first = await indexer.history(row.orderId, "0", 1);
    const rest = await indexer.history(row.orderId, first[0]!.position, 50);
    assert.deepEqual([...first, ...rest], history);
    const purchase = history.find(event => event.name === "Purchased")!;
    assert.equal((await chain.transaction(purchase.transactionHash, row.buyer)).status, "finalized_success");
    evidence.push({ orderId: row.orderId, state: row.state, events: history.length, requestRecovery: "finalized", receipt: "canonical_finalized" });
  }
  const unauthorized = await fetch(config.ENVIO_GRAPHQL_URL!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "{ChainOrder{orderId}}" }) });
  assert.ok((await unauthorized.json() as { errors?: unknown }).errors, "Unauthenticated GraphQL must reject access");
  const tables = await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('catalog_products','offer_revisions','checkout_intents','purchased_offers','auth_sessions','pending_operations') ORDER BY table_name");
  assert.equal(tables.rows.length, 6);
  const report = { checkedAt: new Date().toISOString(), deployment: deploymentKey, freshness, orders: evidence, applicationTables: tables.rows.map(r => r.table_name), anonymousGraphQL: "rejected", rpcMetrics: chain.metrics };
  await mkdir(new URL("../../output/phase-4/", import.meta.url), { recursive: true });
  await writeFile(new URL("../../output/phase-4/live-check.json", import.meta.url), JSON.stringify(report, null, 2));
  console.info(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error instanceof Error && "code" in error ? String(error.code) : "Phase 4 live check failed; inspect assertions locally without logging credentials.");
  process.exitCode = 1;
} finally { await db.end(); }
