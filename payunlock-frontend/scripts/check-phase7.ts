import { mkdir, readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { Wallet, JsonRpcProvider, Transaction, ZeroAddress, parseEther, formatEther, hexlify, randomBytes } from "ethers";
import { clearItemKeys, encodeBase64 } from "@zkbytes/sdk";
import { buildApp } from "../../payunlock-backend/src/app.js";
import { loadConfig } from "../../payunlock-backend/src/config.js";
import { ChainService, escrowAddress } from "../../payunlock-backend/src/services/chain-service.js";
import { BulkJournal, assignments, type BulkManifest } from "../src/commerce/bulk-journal";
import { runBulkDelivery, runBulkRefunds, type BulkRuntime } from "../src/commerce/bulk-runner";
import { newReceivingContext, newOfferReceivingContext, restoreReceiving, restoreReceivingKeys, prepareDelivery, openDelivery } from "../src/commerce/protocol";
import { protocolOrder, hexKey, storageService } from "../src/commerce/lifecycle";
import { ApiError, type Action, type Configuration, type OrderView, type Page, type PreparedTx } from "../src/commerce/client";
import type { LocalStore } from "../src/storage/local-store";

if (!process.argv.includes("--send-test-transactions")) throw new Error("Pass --send-test-transactions for dedicated Testnet acceptance.");
const root = new URL("../../output/phase-7/", import.meta.url); await mkdir(root, { recursive: true });
const config = loadConfig(), provider = new JsonRpcProvider(config.MONAD_TESTNET_RPC_URL), chain = new ChainService(config.MONAD_TESTNET_RPC_URL);
const app = buildApp({ ...config, LOG_LEVEL: "silent" }), origin = "http://127.0.0.1:4320", tokens = new Map<string, string>();
const password = "synthetic phase seven recovery fixture";
async function read<T>(name: string): Promise<T | undefined> { try { return JSON.parse(await readFile(new URL(name, root), "utf8")); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; } }
const save = (name: string, value: unknown) => writeFile(new URL(name, root), JSON.stringify(value, null, 2));
class DiskStore implements LocalStore {
  get(key: string) { return read(`protected-${key.replaceAll(":", "-")}.json`); }
  async put(key: string, value: unknown) { await save(`protected-${key.replaceAll(":", "-")}.json`, value); }
  async remove() { throw new Error("Acceptance retains recovery."); }
  async compareAndSwap(key: string, before: unknown, value: unknown) { assert.deepEqual(await this.get(key), before); await this.put(key, value); }
}
const journal = new BulkJournal(new DiskStore());
type Report = { productId?: string; productKey?: string; orders: string[]; requests: string[]; transactions: Record<string, string>; operation?: string; refunds?: string; status?: string; checks: string[] };
const report: Report = await read("acceptance.json") ?? { orders: [], requests: [], transactions: {}, checks: [] }, record = () => save("acceptance.json", report);
async function api<T>(actor: Wallet | null, path: string, body?: unknown, method?: "GET" | "POST" | "PUT"): Promise<T> {
  const result = await app.inject({ method: method ?? (body === undefined ? "GET" : "POST"), url: `/v1${path}`, headers: { origin, ...(actor ? { authorization: `Bearer ${tokens.get(actor.address)}` } : {}) }, ...(body === undefined ? {} : { payload: body as object }) });
  if (result.statusCode !== 200) throw new ApiError(result.json().error ?? `HTTP_${result.statusCode}`);
  return result.json();
}
async function login(actor: Wallet) { const c = await api<{ id: string; message: string }>(null, "/auth/challenge", { address: actor.address }); const result = await api<{ token: string }>(null, "/auth/verify", { id: c.id, signature: await actor.signMessage(c.message) }); tokens.set(actor.address, result.token); }
async function final(hash: string, actor: Wallet, target = escrowAddress) { for (let i = 0; i < 80; i++) { const r = await chain.transaction(hash, actor.address.toLowerCase(), target); if (r.status === "finalized_revert") throw new Error("Test transaction reverted"); if (r.status === "finalized_success") return; await new Promise(r => setTimeout(r, 1000)); } throw new Error("Finality pending; rerun to recover."); }
async function rawFor(actor: Wallet, tx: PreparedTx) { return actor.signTransaction({ chainId: 10143, type: 2, to: tx.to, data: tx.data, value: BigInt(tx.value), nonce: tx.nonce, gasLimit: BigInt(tx.gas), maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) }); }
async function send(label: string, actor: Wallet, action: Action) {
  if (report.transactions[label]) { await final(report.transactions[label], actor); return report.transactions[label]; }
  const tx = await api<PreparedTx>(actor, "/transactions/prepare", action), raw = await rawFor(actor, tx), hash = Transaction.from(raw).hash!;
  report.transactions[label] = hash; await record();
  await save(`signed-${label}.json`, { raw, action }); // Ignored test-only recovery artifact.
  await api(actor, "/transactions/broadcast", { action, raw }); await final(hash, actor); console.info(`Finalized: ${label}`); return hash;
}
try {
  assert.equal((await provider.getNetwork()).chainId, 10143n); await app.ready();
  if (report.status === "passed") { console.info("Phase 7 live acceptance already passed; no additional transactions."); }
  else {
    const actors = JSON.parse(await readFile(new URL("../../output/phase-6.6/actors.json", import.meta.url), "utf8"));
    const admin = new Wallet(process.env.MONAD_TESTNET_DEPLOYER_KEY!, provider), seller = new Wallet(actors.seller, provider), buyer = new Wallet(actors.buyer, provider);
    console.info(`Test deployer balance: ${formatEther(await provider.getBalance(admin.address))} MON`);
    for (const actor of [seller, buyer]) {
      const balance = await provider.getBalance(actor.address), minimum = parseEther(actor === seller ? "3.8" : "1.2");
      if (balance < minimum) { const tx = await admin.sendTransaction({ to: actor.address, value: minimum - balance, nonce: await provider.getTransactionCount(admin.address, "pending") }); await tx.wait(); }
      await login(actor);
    }
    if (!report.productId) {
      const p = await api<{ id: string }>(seller, "/seller/products", { title: "Phase 7 private access passes", description: "Synthetic bulk acceptance. No real purchase.", visibility: "hidden", draftTerms: { token: ZeroAddress, price: "1000000000000", eventEnd: null, reviewWindow: "86400", commitmentWindow: 600 } });
      report.productId = p.id; report.productKey = newOfferReceivingContext({ chainId: 10143, contract: escrowAddress }, seller.address, p.id).nonce; await record();
    }
    const deployment = { chainId: 10143 as const, contract: escrowAddress }, context = newOfferReceivingContext(deployment, seller.address, report.productId);
    let signatures = 0;
    const signer = { address: seller.address, signMessage: (message: string) => { signatures++; return seller.signMessage(message); } };
    const keys = await restoreReceivingKeys(context, signer, () => true), buyerContext = await read<ReturnType<typeof newReceivingContext>>("buyer-context.json") ?? newReceivingContext(deployment, buyer.address);
    await save("buyer-context.json", buyerContext);
    const receiving = await restoreReceiving(buyerContext, buyer, () => true), sellerReceiving = { nonce: context.nonce, publicKey: hexKey(encodeBase64(keys.encryptionPublicKey)) }, buyerReceiving = { nonce: buyerContext.nonce, publicKey: hexKey(receiving.publicKey) };
    try {
      await api(seller, `/seller/products/${report.productId}/registration`, { productKey: report.productKey }, "PUT");
      await send("register-offer", seller, { kind: "create", productId: report.productId, receiving: sellerReceiving });
      for (let i = report.orders.length; i < 33; i++) {
        report.requests[i] ??= hexlify(randomBytes(32)); await record();
        const checkout = await api<{ configuration: Configuration }>(buyer, `/products/${report.productId}/checkout`, { requestId: report.requests[i], buyerReceiving });
        await send(`purchase-${i + 1}`, buyer, { kind: "purchase", requestId: report.requests[i]!, expectedTerms: checkout.configuration.expectedTerms });
        const recovered = await api<{ orderId: string }>(buyer, `/orders/recover/${report.requests[i]}`); report.orders.push(recovered.orderId); await record();
      }
      const service = storageService(await api(null, "/storage-service?id=1&prepare=true"));
      const readOrders = async (ids: string[]) => { const views: OrderView[] = []; for (let i = 0; i < ids.length; i += 30) views.push(...(await api<{ items: OrderView[] }>(seller, "/orders/batch", { orderIds: ids.slice(i, i + 30) })).items); return views; };
      let op: BulkManifest;
      if (report.operation) op = await journal.load(report.operation, password);
      else {
        const orders = (await readOrders(report.orders.slice(0, 30))).map(v => protocolOrder(v, deployment));
        const entries = assignments(orders, "Private event access. Keep your ticket safe.", "tickets", "", new Map(orders.map(o => [o.orderId, crypto.randomUUID()])));
        op = { version: 1, kind: "delivery", id: crypto.randomUUID(), account: seller.address.toLowerCase(), deployment, productId: report.productId, productKey: report.productKey!, orderIds: orders.map(o => o.orderId), createdAt: new Date().toISOString(), mode: "tickets", transactions: [], complete: false };
        await journal.create(op, entries, password, () => true); report.operation = op.id; await record();
      }
      let lastStage = "";
      const runtime: BulkRuntime = { journal, password, current: () => true, api: { read: path => api(null, path), request: (path, body, method) => api(seller, path, body, method as "GET" | "POST" | "PUT") },
        prepare: (entry, view) => prepareDelivery({ order: entry.order, payload: entry.payload, signer, offerKeys: keys, service, latestPublicationSeconds: BigInt(Math.max(view.block.timestamp, Math.floor(Date.now() / 1000))) + BigInt(view.order.terms.commitmentWindow), isCurrent: () => true }),
        send: async (tx, action, remember) => { const raw = await rawFor(seller, tx), hash = Transaction.from(raw).hash!; await remember(hash, raw); await save(`signed-bulk-${hash}.json`, { raw, action }); await api(seller, "/transactions/broadcast", { raw, action }); },
        update: stage => { if (lastStage !== stage) { lastStage = stage; console.info(stage); } } };
      // Recover the exact bytes retained by an interrupted earlier acceptance invocation.
      for (const pending of op.transactions.filter(t => t.hash && !t.raw && ["signing", "checking"].includes(t.status))) {
        const saved = await read<{ raw: string }>(`signed-bulk-${pending.hash}.json`);
        if (saved) { assert.equal(Transaction.from(saved.raw).hash, pending.hash); pending.raw = saved.raw; await journal.save(op, password); }
      }
      await runBulkDelivery(runtime, op); assert(op.complete); assert.equal(signatures, 1);
      const entries = await Promise.all(op.orderIds.map(id => journal.entry(op.id, id, password)));
      assert.equal(new Set(entries.map(e => e.prepared!.item.seed)).size, 30); assert.equal(new Set(entries.map(e => e.prepared!.item.creator.publicKey)).size, 1);
      for (const entry of entries) {
        const p = entry.prepared!;
        const opened = await openDelivery({ record: p.record, expectedRecordHash: p.recordHash, order: entry.order, role: "buyer", privateKey: receiving.privateKey, services: [service], isCurrent: () => true }); assert.deepEqual(opened.payload, entry.payload);
      }
      const restored = await restoreReceiving(context, seller, () => true, encodeBase64(keys.encryptionPublicKey));
      try { const e = entries[0]!, p = e.prepared!; assert.deepEqual((await openDelivery({ record: p.record, expectedRecordHash: p.recordHash, order: e.order, role: "seller", privateKey: restored.privateKey, services: [service], isCurrent: () => true })).payload, e.payload); } finally { restored.privateKey.fill(0); }
      report.checks = ["30 distinct live encrypted objects opened by buyer", "Repeated buyer retains 30 order-specific tickets", "One offer-key restoration signature", "Independent seller restoration", "Finalized TX1 then TX2 using production bulk runner"];
      await record();
      await send("unpublished-reservation", seller, { kind: "reserveDelivery", orderId: report.orders[30]! });
      let refund: BulkManifest;
      if (report.refunds) refund = await journal.load(report.refunds, password);
      else {
        const views = await readOrders(report.orders);
        refund = { ...op, revision: 0, kind: "refund", id: crypto.randomUUID(), orderIds: report.orders, transactions: [], complete: false };
        await journal.create(refund, views.map(v => ({ order: protocolOrder(v, deployment), payload: { text: "", tickets: [] }, status: "draft" })), password, () => true); report.refunds = refund.id; await record();
      }
      await runBulkRefunds(runtime, refund, true); await runBulkRefunds(runtime, refund); assert(refund.complete);
      const outcomes = await readOrders(report.orders); assert(outcomes.slice(0, 30).every(v => v.order.state === 3)); assert(outcomes.slice(30).every(v => v.order.state === 9));
      const indexed: string[] = []; let after: string | null = "0";
      do { const page: Page<OrderView> = await api(seller, `/seller/products/${report.productId}/orders?after=${after}&limit=10`); indexed.push(...page.items.map(v => v.orderId)); after = page.nextCursor; } while (after);
      assert.deepEqual(indexed, report.orders);
      report.checks.push("Canceled offer refunds Paid and unpublished committed orders; 30 published orders preserved", "Envio product-specific pagination returns each order once"); report.status = "passed"; await record(); console.info("Phase 7 live acceptance passed.");
    } finally { clearItemKeys(keys); receiving.privateKey.fill(0); }
  }
} catch (e) { console.error(e instanceof ApiError ? e.code : (e as Error).message.replace(/https?:\/\/\S+/g, "[redacted URL]")); process.exitCode = 1; }
finally { await app.close(); provider.destroy(); }
