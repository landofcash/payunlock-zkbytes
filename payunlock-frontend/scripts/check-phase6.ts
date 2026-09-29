// Opt-in, resumable acceptance against the configured Monad TESTNET deployment.
// Test keys and encrypted drafts stay under ignored output/. Never print credentials.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { JsonRpcProvider, Wallet, Transaction, parseEther, hexlify, randomBytes, ZeroAddress } from "ethers";
import { buildApp } from "../../payunlock-backend/src/app.js";
import { loadConfig } from "../../payunlock-backend/src/config.js";
import { ChainService, escrowAddress } from "../../payunlock-backend/src/services/chain-service.js";
import type { Action as BackendAction } from "../../payunlock-backend/src/services/transaction-service.js";
import { FulfillmentJournal } from "../src/commerce/journal";
import { newReceivingContext, restoreReceiving, prepareDelivery, openDelivery } from "../src/commerce/protocol";
import { prepareRequest, openRequest, persistRequest, restoreRequest, type RequestRow, type RequestOpening } from "../src/commerce/requests";
import { prepareEvidence, persistEvidence, restoreEvidence, openEvidence } from "../src/commerce/evidence";
import { protocolOrder, storageService, reference, deliveryRecord, arbitratorContext, hexKey, assignment, evidenceReference, evidenceRecord, type ChainRecord, type EvidenceReference } from "../src/commerce/lifecycle";
import type { OrderView, Page, PreparedTx } from "../src/commerce/client";
import type { LocalStore } from "../src/storage/local-store";

if (!process.argv.includes("--send-test-transactions")) throw new Error("Explicit --send-test-transactions is required.");
const root = new URL("../../output/phase-6.5/", import.meta.url); await mkdir(root, { recursive: true });
const config = loadConfig(), provider = new JsonRpcProvider(config.MONAD_TESTNET_RPC_URL), chain = new ChainService(config.MONAD_TESTNET_RPC_URL);
const app = buildApp({ ...config, LOG_LEVEL: "silent" }), origin = "http://127.0.0.1:4320", tokens = new Map<string, string>();
const password = "synthetic-phase-six-test-material-only";
async function read<T>(name: string): Promise<T | undefined> { try { return JSON.parse(await readFile(new URL(name, root), "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
const save = (name: string, value: unknown) => writeFile(new URL(name, root), JSON.stringify(value, null, 2));
class ProbeStore implements LocalStore {
  async get(key: string) { return read(`encrypted-${key.replaceAll(":", "-")}.json`); }
  async put(key: string, value: unknown) { await save(`encrypted-${key.replaceAll(":", "-")}.json`, value); }
  async remove() { throw new Error("Acceptance retains encrypted drafts."); }
  async compareAndSwap(key: string, expected: unknown, value: unknown) { assert.equal(JSON.stringify(await this.get(key)), JSON.stringify(expected)); await this.put(key, value); }
}
const store = new ProbeStore(), recovery = new FulfillmentJournal(store);
type Report = { at: string; chainId: number; contract: string; steps: Record<string, { hash: string; status: string }>; orders: Record<string, string>; checks: string[]; status?: string };
const report: Report = await read("acceptance.json") ?? { at: new Date().toISOString(), chainId: 10143, contract: escrowAddress, steps: {}, orders: {}, checks: [] };
const writeReport = () => save("acceptance.json", report);
async function api<T = Record<string, unknown>>(actor: Wallet | null, path: string, body?: unknown, method?: "GET" | "POST" | "PUT"): Promise<T> {
  const response = await app.inject({ method: method ?? (body === undefined ? "GET" : "POST"), url: `/v1${path}`, headers: { origin, ...(actor ? { authorization: `Bearer ${tokens.get(actor.address)}` } : {}) }, ...(body === undefined ? {} : { payload: body as Record<string, unknown> }) });
  if (response.statusCode !== 200) throw new Error(`${path}: ${response.statusCode} ${response.json().error}`);
  return response.json();
}
async function login(actor: Wallet) { const c = await api<{ id: string; message: string }>(null, "/auth/challenge", { address: actor.address }); const v = await api<{ token: string }>(null, "/auth/verify", { id: c.id, signature: await actor.signMessage(c.message) }); tokens.set(actor.address, v.token); }
async function final(hash: string, actor: Wallet, target = escrowAddress) {
  for (let i = 0; i < 80; i++) { const r = await chain.transaction(hash, actor.address.toLowerCase(), target); if (r.status === "finalized_revert") throw new Error("Acceptance transaction reverted"); if (r.status === "finalized_success") return; await new Promise(r => setTimeout(r, 1000)); }
  throw new Error("Finality remains uncertain. Rerun to recover the saved transaction.");
}
async function send(label: string, actor: Wallet, action: BackendAction) {
  if (report.steps[label]) { await final(report.steps[label].hash, actor); return report.steps[label].hash; }
  const tx = await api<PreparedTx>(actor, "/transactions/prepare", action);
  const raw = await actor.signTransaction({ chainId: 10143, type: 2, to: tx.to, data: tx.data, value: BigInt(tx.value), nonce: tx.nonce, gasLimit: BigInt(tx.gas), maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) });
  const hash = Transaction.from(raw).hash!;
  report.steps[label] = { hash, status: "prepared" }; await writeReport();
  // Persist raw SIGNED test transaction only in the ignored recovery artifact, never logs.
  await save(`signed-${label}.json`, { raw, action, account: actor.address });
  await api(actor, "/transactions/broadcast", { action, raw }); await final(hash, actor);
  report.steps[label].status = "finalized"; await writeReport(); console.info(`Finalized: ${label}`); return hash;
}
try {
  assert.equal((await provider.getNetwork()).chainId, 10143n); await app.ready();
  if (report.status === "passed" && !process.argv.includes("--prepare-browser-order") && !process.argv.includes("--retire-test-arbitrators")) { console.info("Phase 6.5 acceptance already passed; no new transactions."); }
  else {
    let keys = await read<{ seller: string; buyer: string; arb: string; replacement: string }>("actors.json");
    if (!keys) { const prior = JSON.parse(await readFile(new URL("../../output/phase-5/actors.json", import.meta.url), "utf8")); keys = { seller: prior.seller, buyer: prior.buyer, arb: Wallet.createRandom().privateKey, replacement: Wallet.createRandom().privateKey }; await save("actors.json", keys); }
    const admin = new Wallet(process.env.MONAD_TESTNET_DEPLOYER_KEY!, provider), seller = new Wallet(keys.seller, provider), buyer = new Wallet(keys.buyer, provider), arb = new Wallet(keys.arb, provider), replacement = new Wallet(keys.replacement, provider);
    for (const actor of [seller, buyer, arb, replacement]) {
      const minimum = parseEther(actor === seller || actor === buyer ? "0.45" : "0.15"), balance = await provider.getBalance(actor.address);
      if (balance < minimum && !process.argv.includes("--prepare-browser-order") && !process.argv.includes("--retire-test-arbitrators")) { const tx = await admin.sendTransaction({ to: actor.address, value: minimum - balance, nonce: await provider.getTransactionCount(admin.address, "pending") }); await tx.wait(); }
      await login(actor);
    }
    await login(admin);
    const deployment = { chainId: 10143 as const, contract: escrowAddress }, service = storageService(await api(null, "/storage-service"));
    let contexts = await read<{ buyer: ReturnType<typeof newReceivingContext>; seller: ReturnType<typeof newReceivingContext> }>("contexts.json");
    if (!contexts) { contexts = { buyer: newReceivingContext(deployment, buyer.address), seller: newReceivingContext(deployment, seller.address) }; await save("contexts.json", contexts); }
    const identities = { buyer: await restoreReceiving(contexts.buyer, buyer, () => true), seller: await restoreReceiving(contexts.seller, seller, () => true) };
    const buyerReceiving = { nonce: contexts.buyer.nonce, publicKey: hexKey(identities.buyer.publicKey) }, sellerReceiving = { nonce: contexts.seller.nonce, publicKey: hexKey(identities.seller.publicKey) };
    identities.buyer.privateKey.fill(0); identities.seller.privateKey.fill(0);
    async function order(name: string, reviewWindow = "600") {
      if (report.orders[name]) return report.orders[name];
      let f = await read<{ productId: string; requestId: string; key: string }>(`order-${name}.json`);
      if (!f) { const p = await api<{ id: string }>(seller, "/seller/products", { title: `Phase 6 ${name}`, description: "Synthetic acceptance", visibility: "hidden", draftTerms: { token: ZeroAddress, price: "1000000000000", eventEnd: null, reviewWindow, commitmentWindow: name === "expired" ? 60 : 600 } }); f = { productId: p.id, requestId: hexlify(randomBytes(32)), key: hexlify(randomBytes(32)) }; await save(`order-${name}.json`, f); }
      await api(seller, `/seller/products/${f.productId}/registration`, { productKey: f.key }, "PUT");
      await send(`${name}-create`, seller, { kind: "create", productId: f.productId, receiving: sellerReceiving });
      const checkout = await api<{ configuration: { expectedTerms: string } }>(buyer, `/products/${f.productId}/checkout`, { requestId: f.requestId, buyerReceiving });
      const recovered = await api<{ status: string; orderId: string }>(buyer, `/orders/recover/${f.requestId}`);
      if (recovered.status !== "finalized") await send(`${name}-purchase`, buyer, { kind: "purchase", requestId: f.requestId, expectedTerms: checkout.configuration.expectedTerms });
      const result = await api<{ orderId: string }>(buyer, `/orders/recover/${f.requestId}`); report.orders[name] = result.orderId; await writeReport(); return result.orderId;
    }
    async function publish(name: string, orderId: string, actor = seller, turn = "0") {
      const view = await api<OrderView>(actor, `/orders/${orderId}`), bound = protocolOrder(view, deployment);
      let pointer = await read<{ id: string }>(`draft-${name}.json`);
      if (!pointer) { const p = await prepareDelivery({ order: bound, payload: { text: `Synthetic ${name}`, tickets: [] }, kind: turn === "0" ? "delivery" : "message", turn, signer: actor, service, latestPublicationSeconds: BigInt(Math.floor(Date.now() / 1000) + 600), isCurrent: () => true }); pointer = { id: await recovery.prepare(p, password, () => true) }; await save(`draft-${name}.json`, pointer); }
      let p = await recovery.restore(pointer.id, password);
      if (p.progress === "prepared") await recovery.upload(pointer.id, password, service.client, () => true);
      p = await recovery.restore(pointer.id, password);
      if (p.progress === "upload-uncertain") assert.equal(await recovery.recoverUpload(pointer.id, password, service.client, () => true), "active");
      p = await recovery.restore(pointer.id, password);
      if (turn === "0") {
        if (p.progress === "uploaded") await recovery.update(pointer.id, password, "tx1-pending");
        const hash = await send(`${name}-commit`, actor, { kind: "reserveDelivery", orderId });
        const check = await api<{ eligible: boolean }>(actor, `/orders/${orderId}/publication-check`, { reservationTransaction: hash });
        if (!report.steps[`${name}-publish`]) assert.equal(check.eligible, true);
        p = await recovery.restore(pointer.id, password);
        if (p.progress === "tx1-pending") { await recovery.update(pointer.id, password, "tx1-pending", hash); await recovery.update(pointer.id, password, "tx1-finalized"); }
        p = await recovery.restore(pointer.id, password); if (p.progress === "tx1-finalized") await recovery.update(pointer.id, password, "tx2-pending");
        await send(`${name}-publish`, actor, { kind: "publishDelivery", orderId, reference: reference(p.record), reservationTransaction: hash });
        p = await recovery.restore(pointer.id, password); if (p.progress === "tx2-pending") await recovery.update(pointer.id, password, "published");
      } else await send(`${name}-message`, actor, turn === "1" ? { kind: "openDispute", orderId, reference: reference(p.record) } : { kind: "replyToDispute", orderId, expectedTurn: turn, reference: reference(p.record) });
      const row = (await api<Page<ChainRecord>>(actor, `/orders/${orderId}/records?after=${BigInt(turn) - 1n}`)).items[0]!;
      assert.equal(row.commitment, p.recordHash);
      for (const role of ["buyer", "seller"] as const) {
        const restored = await restoreReceiving(bound[role].context, role === "buyer" ? buyer : seller, () => true, bound[role].publicKey);
        try { const opened = await openDelivery({ record: deliveryRecord(row, bound), expectedRecordHash: row.commitment, order: bound, role, privateKey: restored.privateKey, services: [service], isCurrent: () => true }); assert.equal(opened.payload.text, `Synthetic ${name}`); }
        finally { restored.privateKey.fill(0); }
      }
      return p.opening;
    }
    if (process.argv.includes("--retire-test-arbitrators")) {
      for (const [label, actor] of [["arb", arb], ["replacement", replacement]] as const) {
        const registry = await api<{ publicKey: string; fee: string }>(null, `/arbitrators/${actor.address}`);
        await send(`${label}-retire`, admin, { kind: "configureArbitrator", wallet: actor.address.toLowerCase(), publicKey: registry.publicKey, fee: registry.fee, active: false });
      }
      report.checks.push("test-only arbitrators disabled after acceptance"); await writeReport();
    } else if (process.argv.includes("--prepare-browser-order")) {
      const browserOrder = await order("browser", "86400"); console.info(`Browser fixture ready: order ${browserOrder}.`);
    } else {
    const accepted = await order("accepted"); await publish("accepted", accepted); await send("accepted-confirm", buyer, { kind: "confirmReceipt", orderId: accepted }); await send("accepted-payout", seller, { kind: "withdrawSeller", orderId: accepted });
    const timeout = await order("timeout", "0"); await publish("timeout", timeout); await send("timeout-payout", seller, { kind: "withdrawSeller", orderId: timeout });
    const refunded = await order("refund"); await send("paid-refund", buyer, { kind: "claimRefund", orderId: refunded });
    const expired = await order("expired"); await send("expired-commit", seller, { kind: "reserveDelivery", orderId: expired });
    const negotiation = await order("negotiation"); await publish("negotiation", negotiation); await publish("negotiation-open", negotiation, buyer, "1"); await publish("negotiation-reply", negotiation, seller, "2"); await publish("negotiation-reply2", negotiation, buyer, "3"); await send("negotiation-refund", seller, { kind: "refundDisputedOrder", orderId: negotiation });
    const caseId = await order("arbitration"); const originals = [await publish("arbitration", caseId), await publish("arbitration-open", caseId, buyer, "1")];
    for (const [label, actor] of [["arb", arb], ["replacement", replacement]] as const) {
      const identity = await restoreReceiving(arbitratorContext(deployment, actor.address), actor, () => true);
      try { await send(`${label}-register`, admin, { kind: "configureArbitrator", wallet: actor.address.toLowerCase(), publicKey: hexKey(identity.publicKey), fee: "1000000000000", active: true }); }
      finally { identity.privateKey.fill(0); }
    }
    for (const [revision, actor] of [["1", arb], ["2", replacement]] as const) {
      const registry = await api<{ wallet: string; publicKey: string; keyVersion: string; fee: string }>(null, `/arbitrators/${actor.address}`);
      if (revision === "2") await send("replace-arbitrator", admin, { kind: "replaceArbitrator", orderId: caseId, revision: "1", replacement: actor.address.toLowerCase(), expectedKeyVersion: registry.keyVersion, reason: hexlify(randomBytes(32)) });
      const view = await api<OrderView>(buyer, `/orders/${caseId}`), bound = protocolOrder(view, deployment), a = assignment(caseId, { ...registry, revision });
      const requests = (await api<Page<RequestRow>>(buyer, `/orders/${caseId}/evidence-requests`)).items;
      const copies: RequestOpening[] = [];
      if (revision === "2") {
        const identity = await restoreReceiving(bound.buyer.context, buyer, () => true, bound.buyer.publicKey);
        try { for (const row of requests) copies.push(await openRequest({ row, order: bound, role: "buyer", privateKey: identity.privateKey, service, availableSequences: ["0", "1"], isCurrent: () => true })); }
        finally { identity.privateKey.fill(0); }
      }
      let pointer = await read<{ id: string }>(`evidence-${revision}.json`);
      if (!pointer) { const p = await prepareEvidence({ originals, requests: copies, expectedRequests: requests.map(r => r.commitment), availableSequences: ["0", "1"], expected: originals.map(o => commitmentFor(o)), order: bound, assignment: a, unreadable: [], signer: buyer, serviceId: service.id, maxRetentionSeconds: service.maxRetentionSeconds, latestPublicationSeconds: BigInt(Math.floor(Date.now() / 1000) + 600), isCurrent: () => true }); pointer = { id: await persistEvidence(store, p, password, () => true) }; await save(`evidence-${revision}.json`, pointer); }
      const p = await restoreEvidence(store, pointer.id, password);
      const status = await service.client.recoverUpload(p.item.seed, p.record.creator);
      if (status.outcome === "not-found") await service.client.upload(p.item); else assert.equal(status.outcome, "active");
      const e = evidenceReference(p);
      await send(`evidence-${revision}-submit`, buyer, revision === "1" ? { kind: "requestArbitration", orderId: caseId, wallet: actor.address.toLowerCase(), expectedKeyVersion: registry.keyVersion, expectedFee: registry.fee, evidence: e } : { kind: "submitArbitrationEvidence", orderId: caseId, revision, evidence: e });
      let published: { revision: string; commitment: string; data: EvidenceReference } | undefined;
      for (let i = 0; i < 30 && !published; i++) { const page = await api<Page<{ revision: string; commitment: string; data: EvidenceReference }>>(actor, `/orders/${caseId}/evidence`); published = page.items.find(r => r.revision === revision); if (!published) await new Promise(r => setTimeout(r, 1000)); }
      assert.ok(published);
      const identity = await restoreReceiving(arbitratorContext(deployment, actor.address), actor, () => true, a.publicKey);
      try { const opened = await openEvidence({ record: evidenceRecord(published.data, a, bound), expectedRecordHash: published.commitment, role: "arbitrator", privateKey: identity.privateKey, serviceId: service.id, download: (seed, creator) => service.client.downloadAndVerify(seed, creator), assignment: a, order: bound, expectedRequests: requests.map(r => r.commitment), availableSequences: ["0", "1"], expected: originals.map(o => commitmentFor(o)), isCurrent: () => true }); assert.equal(opened.report.verified.length, 2); if (revision === "2") assert.equal(opened.evidence.requests.length, 1); }
      finally { identity.privateKey.fill(0); }
      if (revision === "1") {
        const key = `request:${escrowAddress}:${caseId}:1`;
        if (!await store.get(key)) {
          const prepared = await prepareRequest({ order: bound, assignment: a, index: "0", participant: seller.address.toLowerCase(), advisoryDate: String(Math.floor(Date.now() / 1000) + 86400), sequences: ["0", "1"], instructions: "Please provide the original delivery and reply.", availableSequences: ["0", "1"], signer: arb, service, isCurrent: () => true });
          await persistRequest(store, key, prepared, password, () => true);
        }
        const prepared = await restoreRequest(store, key, password);
        const status = await service.client.recoverUpload(prepared.item.seed, prepared.record.reference.creator);
        if (status.outcome === "not-found") await service.client.upload(prepared.item); else assert.equal(status.outcome, "active");
        await send("evidence-request", arb, { kind: "requestArbitrationEvidence", orderId: caseId, revision, expectedIndex: "0", participant: prepared.record.participant, request: evidenceReference({ record: prepared.record.reference } as Parameters<typeof evidenceReference>[0]), advisoryDate: prepared.record.advisoryDate });
        let row: RequestRow | undefined;
        for (let i = 0; i < 30 && !row; i++) { row = (await api<Page<RequestRow>>(buyer, `/orders/${caseId}/evidence-requests`)).items[0]; if (!row) await new Promise(r => setTimeout(r, 1000)); }
        assert.ok(row); assert.equal(row.commitment, prepared.recordHash);
        for (const [role, reader] of [["buyer", buyer], ["seller", seller], ["arbitrator", arb]] as const) {
          const identity = await restoreReceiving(role === "arbitrator" ? arbitratorContext(deployment, reader.address) : bound[role].context, reader, () => true);
          try { const opened = await openRequest({ row, order: bound, role, privateKey: identity.privateKey, service, availableSequences: ["0", "1"], isCurrent: () => true }); assert.deepEqual(opened.content.sequences, ["0", "1"]); }
          finally { identity.privateKey.fill(0); }
        }
      }
    }
    await send("arbitration-award", replacement, { kind: "resolveArbitration", orderId: caseId, revision: "2", sellerWins: false });
    for (let i = 0; i < 65; i++) { const v = await api<OrderView>(buyer, `/orders/${expired}`); if (v.eligibility.claimRefund || v.order.state === 9) break; await new Promise(r => setTimeout(r, 1000)); }
    await send("expired-refund", buyer, { kind: "claimRefund", orderId: expired });
    for (const [name, state] of [["accepted", 8], ["timeout", 8], ["refund", 9], ["expired", 9], ["negotiation", 9], ["arbitration", 9]] as const) assert.equal((await api<OrderView>(buyer, `/orders/${report.orders[name]}`)).order.state, state);
    report.checks = ["independent buyer/seller restoration", "encrypted draft reload between TX1/TX2", "delivery acceptance and explicit payout", "zero-review timeout payout", "paid and expired-commitment refunds", "alternating encrypted negotiation and voluntary refund", "paid arbitration with verified evidence", "encrypted request independently opened by buyer, seller and arbitrator", "replacement and independently verified re-encrypted request/evidence handover", "replacement final award before advisory date"];
    report.status = "passed"; await writeReport(); console.info("Phase 6.5 live acceptance passed.");
    }
  }
} catch (error) { console.error(error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, "[redacted endpoint]").slice(0, 350) : "Acceptance failed"); process.exitCode = 1; }
finally { await app.close(); provider.destroy(); }
import { contentHash as commitmentFor } from "../src/commerce/protocol";
