// @vitest-environment node
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Wallet, Transaction } from "ethers";
import { ZkbytesClient, type StorageItem } from "@zkbytes/sdk";
import { IndexedStore } from "@/storage/local-store";
import { WalletVault } from "@/wallet/vault";
import { unlockWallet } from "@/wallet/managed-session";
import { checkCompatibility } from "@/wallet/compatibility";
import { contentHash, expiration, newReceivingContext, openDelivery, prepareDelivery, publishEligibility, recordHash, restoreReceiving, RETENTION_SECONDS, type Order, type Opening } from "@/commerce/protocol";
import { FulfillmentJournal } from "@/commerce/journal";
import { openEvidence, prepareEvidence, verifyEvidence, persistEvidence, restoreEvidence } from "@/commerce/evidence";
import { canonical } from "@/crypto/encoding";
import { sendReviewedTransaction } from "@/wallet/transactions";

const password = "correct horse battery staple";
const privateKey = `0x${"0".repeat(63)}1`;
const buyerWallet = new Wallet(privateKey), sellerWallet = new Wallet(`0x${"0".repeat(63)}2`), arbitrator = new Wallet(`0x${"0".repeat(63)}3`);
const current = () => true;
const store = () => new IndexedStore(`test-${crypto.randomUUID()}`);
const transaction = { chainId: 10143 as const, to: sellerWallet.address as `0x${string}`, data: "0x" as const, value: 1n, nonce: 0, gas: 21000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n };
afterEach(() => vi.useRealTimers());

async function fixture() {
  const deployment = { chainId: 10143 as const, contract: "0x" + "a".repeat(40) };
  const buyerContext = { ...newReceivingContext(deployment, buyerWallet.address), nonce: "0x" + "b".repeat(64) };
  const sellerContext = { ...newReceivingContext(deployment, sellerWallet.address), nonce: "0x" + "c".repeat(64) };
  const buyer = await restoreReceiving(buyerContext, buyerWallet, current), seller = await restoreReceiving(sellerContext, sellerWallet, current);
  const order: Order = { deployment, orderId: "42", buyer: { context: buyerContext, publicKey: buyer.publicKey }, seller: { context: sellerContext, publicKey: seller.publicKey }, terms: { version: 1, token: "0x" + "0".repeat(40), price: "100", eventEnd: null, reviewWindow: "100", responseWindow: "259200" } };
  const items = new Map<string, StorageItem>();
  let loseResponse = false;
  const fetcher: typeof fetch = async (url, init) => {
    if (init?.method === "POST") {
      const item = JSON.parse(init.body as string) as StorageItem;
      items.set(item.seed, item);
      if (loseResponse) throw new Error("response lost after storage");
      return Response.json({ version: 1, seed: item.seed, downloadUrl: `https://cdn.example/${item.seed}`, itemSignature: item.itemSignature, createdAt: new Date().toISOString(), expiresAt: item.expiresAt }, { status: 201 });
    }
    const location = new URL(String(url)), seed = location.pathname.endsWith("/status") ? location.pathname.split("/").at(-2)! : location.pathname.slice(1);
    const item = items.get(seed);
    if (!item) return Response.json({ error: { code: "OBJECT_NOT_FOUND", message: "Not found" } }, { status: 404 });
    if (location.pathname.endsWith("/status")) return Response.json({ seed, state: "active", createdAt: new Date().toISOString(), expiresAt: item.expiresAt });
    return Response.json(item);
  };
  const client = new ZkbytesClient({ apiOrigin: "https://api.example", downloadOrigin: "https://cdn.example", fetch: fetcher });
  const service = { id: "fixture-storage-v1", client, maxRetentionSeconds: RETENTION_SECONDS };
  const prepared = await prepareDelivery({ order, payload: { text: "Private ticket delivery", tickets: [{ row: "7", ticket: "SECRET-42" }] }, signer: sellerWallet, service, latestPublicationSeconds: BigInt(Math.floor(Date.now() / 1000) + 3600), isCurrent: current });
  return { order, buyer, seller, client, service, prepared, items, loseResponse: () => { loseResponse = true; } };
}

describe("vault and Mera session", () => {
  it("creates/imports encrypted wallets, exports only after reauthentication, and matches ethers/SDK signatures", async () => {
    const storage = store(), vault = new WalletVault(storage);
    const address = await vault.import(privateKey, password);
    expect(JSON.stringify(await storage.get(`wallet:${address}`))).not.toContain(privateKey);
    await expect(vault.export(address, "incorrect password here")).rejects.toThrow();
    expect((await vault.export(address, password)).privateKey).toBe(privateKey);
    const session = await unlockWallet(vault, address, password, async () => true);
    try {
      expect(await session.signMessage("zkbytes compatibility")).toBe(await buyerWallet.signMessage("zkbytes compatibility"));
      expect(await checkCompatibility(session, current)).toBe(true);
      const context = newReceivingContext({ chainId: 10143, contract: "0x" + "a".repeat(40) }, address);
      const meraIdentity = await restoreReceiving(context, session, current);
      const ethersIdentity = await restoreReceiving(context, buyerWallet, current, meraIdentity.publicKey);
      expect(meraIdentity.privateKey).toEqual(ethersIdentity.privateKey);
      meraIdentity.privateKey.fill(0); ethersIdentity.privateKey.fill(0);
      const signed = await session.signTransaction(transaction);
      expect(Transaction.from(signed).from).toBe(address);
      expect(Transaction.from(signed).chainId).toBe(10143n);
    } finally { session.lock(); }
    await expect(session.signMessage("stale handle")).rejects.toThrow("locked");
    await expect(session.signTransaction(transaction)).rejects.toThrow("locked");
    const created = new WalletVault(store()), generated = await created.create(password);
    const backup = await created.export(generated, password);
    const restored = new WalletVault(store());
    expect(await restored.import(backup.mnemonic!, password)).toBe(generated);
    await expect(restored.import(backup.privateKey, password)).rejects.toThrow("already exists");
  });
  it("actively expires, never refreshes on status reads, and rejects approval after lock", async () => {
    const vault = new WalletVault(store()), address = await vault.import(privateKey, password);
    let allow: (yes: boolean) => void = () => {};
    const session = await unlockWallet(vault, address, password, () => new Promise(resolve => { allow = resolve; }), 50);
    const expired = vi.fn(); session.subscribe(expired);
    const pending = session.signMessage("review");
    session.lock(); allow(true);
    await expect(pending).rejects.toThrow("locked"); expect(expired).toHaveBeenCalledOnce();
    const timed = await unlockWallet(vault, address, password, async () => true, 40);
    const ended = vi.fn(); timed.subscribe(ended);
    expect(timed.locked).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(ended).toHaveBeenCalledOnce(); expect(timed.locked).toBe(true);
    await expect(timed.signMessage("expired")).rejects.toThrow("locked");
    const declined = await unlockWallet(vault, address, password, async () => false);
    try { await expect(declined.signTransaction(transaction)).rejects.toThrow("declined"); } finally { declined.lock(); }
  });
  it("pins reviewed external transaction bytes and refuses a wrong network", async () => {
    const request = vi.fn(async ({ method }: { method: string; params?: unknown[] }) => method === "eth_chainId" ? "0x279f" : "0x" + "d".repeat(64));
    await sendReviewedTransaction(request, transaction, buyerWallet.address, async () => {});
    expect(request.mock.calls[1]![0].params).toEqual([expect.objectContaining({ value: "0x1", from: buyerWallet.address, nonce: "0x0" })]);
    request.mockResolvedValue("0x1");
    await expect(sendReviewedTransaction(request, transaction, buyerWallet.address, async () => {})).rejects.toThrow("Monad Testnet");
  });
});

describe("order-bound delivery and recovery", () => {
  it("restores both participants in empty browsers and pins a stable private content fixture", async () => {
    const f = await fixture(); f.items.set(f.prepared.item.seed, f.prepared.item);
    for (const role of ["buyer", "seller"] as const) {
      const restored = await restoreReceiving(f.order[role].context, role === "buyer" ? buyerWallet : sellerWallet, current, f.order[role].publicKey);
      const opened = await openDelivery({ record: f.prepared.record, expectedRecordHash: f.prepared.recordHash, order: f.order, role, privateKey: restored.privateKey, services: [f.service], isCurrent: current });
      expect(opened).toEqual(f.prepared.opening); restored.privateKey.fill(0);
    }
    const golden: Opening = { ...f.prepared.opening, salt: "0x" + "1".repeat(64) };
    expect(contentHash(golden)).toMatchSnapshot();
    expect(canonical(f.prepared.record)).not.toContain(f.prepared.opening.salt);
    expect(canonical(f.prepared.record)).not.toContain("SECRET-42");
    expect(f.prepared.item.managers).toEqual([]);
    for (const alter of [{ payload: { ...golden.payload, text: "substituted" } }, { salt: "0x" + "2".repeat(64) }, { order: { ...golden.order, orderId: "43" } }, { order: { ...golden.order, deployment: { ...golden.order.deployment, contract: "0x" + "e".repeat(40) } } }, { payload: { text: golden.payload.text, tickets: [{ row: "8", ticket: "SECRET-42" }] } }]) expect(contentHash({ ...golden, ...alter })).not.toBe(contentHash(golden));
    const base = { record: f.prepared.record, expectedRecordHash: f.prepared.recordHash, order: f.order, role: "buyer" as const, privateKey: f.buyer.privateKey, services: [f.service], isCurrent: current };
    await expect(openDelivery({ ...base, order: { ...f.order, orderId: "43" } })).rejects.toThrow("mismatch");
    await expect(openDelivery({ ...base, privateKey: f.seller.privateKey })).rejects.toThrow();
    await expect(openDelivery({ ...base, isCurrent: () => false })).rejects.toThrow("Session");
    const altered = { ...f.prepared.record, creator: { ...f.prepared.record.creator, publicKey: "A".repeat(43) + "=" } };
    await expect(openDelivery({ ...base, record: altered })).rejects.toThrow();
    await expect(restoreReceiving(f.order.buyer.context, sellerWallet, current)).rejects.toThrow("Wrong");
    await expect(restoreReceiving(f.order.buyer.context, buyerWallet, current, f.seller.publicKey)).rejects.toThrow("does not match");
  });
  it("persists before upload, survives a lost response and reload, and retains TX1/TX2 state", async () => {
    const f = await fixture(), storage = store(), journal = new FulfillmentJournal(storage);
    const id = await journal.prepare(f.prepared, password, current);
    await expect(journal.prepare(f.prepared, password, current)).rejects.toThrow("changed");
    expect(JSON.stringify(await storage.get(`pending:${id}`))).not.toContain(f.prepared.item.seed);
    expect(JSON.stringify(await storage.get(`pending:${id}`))).not.toContain(f.prepared.opening.salt);
    f.loseResponse();
    await expect(journal.upload(id, password, f.client, current)).rejects.toThrow("uncertain");
    const reloaded = new FulfillmentJournal(storage);
    expect((await reloaded.restore(id, password)).progress).toBe("upload-uncertain");
    expect(await reloaded.recoverUpload(id, password, f.client, current)).toBe("active");
    await reloaded.update(id, password, "tx1-pending");
    await reloaded.update(id, password, "tx1-finalized");
    const backup = await reloaded.export(id), other = new FulfillmentJournal(store());
    await other.import(backup, password);
    expect((await other.restore(id, password)).opening).toEqual(f.prepared.opening);
    expect((await other.restore(id, password)).progress).toBe("tx1-finalized");
    const state = { commitment: f.prepared.recordHash, finalizedSuccessfulTx1: true, canceled: false, deadline: 100n, chainTime: 99n };
    expect(() => publishEligibility(f.prepared, state)).not.toThrow();
    for (const change of [{ chainTime: 100n }, { canceled: true }, { finalizedSuccessfulTx1: false }, { commitment: "wrong" }]) expect(() => publishEligibility(f.prepared, { ...state, ...change })).toThrow();
    await expect(other.cleanup(id, password)).rejects.toThrow("unpublished");
    await other.update(id, password, "tx2-pending"); await other.update(id, password, "published"); await other.cleanup(id, password);
    await expect(other.restore(id, password)).rejects.toThrow();
  });
  it("does not upload when persistence fails or the session changed", async () => {
    const f = await fixture(), storage = store();
    vi.spyOn(storage, "compareAndSwap").mockRejectedValue(new Error("quota"));
    const journal = new FulfillmentJournal(storage), upload = vi.spyOn(f.client, "upload");
    await expect(journal.prepare(f.prepared, password, current)).rejects.toThrow("quota");
    expect(upload).not.toHaveBeenCalled();
    await expect(journal.prepare(f.prepared, password, () => false)).rejects.toThrow("Session");
  });
  it("enforces one-year retention even with the backend cap disabled", async () => {
    const f = await fixture(), now = Math.floor(Date.now() / 1000) * 1000, latest = BigInt(Math.floor(now / 1000) + 60);
    expect(Date.parse(expiration(now, latest, f.order.terms, 0)) - now).toBe(RETENTION_SECONDS * 1000);
    expect(() => expiration(now, latest, f.order.terms, 2592000)).toThrow("cap");
    expect(() => expiration(now, latest, { ...f.order.terms, reviewWindow: String(RETENTION_SECONDS) }, 0)).toThrow("window");
  });
  it("supports either party's evidence copy, incomplete history, unreadable replies, and reassignment", async () => {
    const f = await fixture();
    const message = await prepareDelivery({ order: f.order, payload: { text: "The prior message is unreadable", tickets: [] }, kind: "message", turn: "1", signer: buyerWallet, service: f.service, latestPublicationSeconds: BigInt(Math.floor(Date.now() / 1000) + 60), isCurrent: current });
    const expected = [f.prepared.record.contentHash, message.record.contentHash];
    const arb = await restoreReceiving(newReceivingContext(f.order.deployment, arbitrator.address), arbitrator, current);
    const assignment = { caseId: "1", revision: "1", wallet: arbitrator.address.toLowerCase(), keyVersion: "1", publicKey: arb.publicKey };
    f.items.set(f.prepared.item.seed, f.prepared.item); f.items.set(message.item.seed, message.item);
    for (const [role, signer] of [["buyer", buyerWallet], ["seller", sellerWallet]] as const) {
      const restoredIdentity = await restoreReceiving(f.order[role].context, signer, current, f.order[role].publicKey);
      const independentHistory = [];
      for (const original of [f.prepared, message]) independentHistory.push(await openDelivery({ record: original.record, expectedRecordHash: original.recordHash, order: f.order, role, privateKey: restoredIdentity.privateKey, services: [f.service], isCurrent: current }));
      restoredIdentity.privateKey.fill(0);
      expect(verifyEvidence(independentHistory, expected, f.order).missing).toEqual([]);
      const proof = await prepareEvidence({ originals: [f.prepared.opening], expected, order: f.order, assignment, unreadable: [message.record.contentHash], signer, service: f.service.id, maxRetentionSeconds: RETENTION_SECONDS, latestPublicationSeconds: BigInt(Math.floor(Date.now() / 1000) + 60), isCurrent: current });
      const storage = store(), recoveryId = await persistEvidence(storage, proof, password, current);
      expect(await restoreEvidence(storage, recoveryId, password)).toEqual(proof);
      f.items.set(proof.item.seed, proof.item);
      const input = { record: proof.record, expectedRecordHash: proof.recordHash, role: "arbitrator" as const, privateKey: arb.privateKey, service: f.service.id, download: f.client.downloadAndVerify.bind(f.client), assignment, order: f.order, expected, isCurrent: current };
      const opened = await openEvidence(input);
      expect(opened.report.missing).toEqual([message.record.contentHash]);
      expect(opened.evidence.originals[0]).toEqual(f.prepared.opening);
      await expect(openEvidence({ ...input, assignment: { ...assignment, revision: "2" } })).rejects.toThrow("assignment");
      const full = await prepareEvidence({ originals: independentHistory, expected, order: f.order, assignment: { ...assignment, revision: "2" }, unreadable: [], signer, service: f.service.id, maxRetentionSeconds: RETENTION_SECONDS, latestPublicationSeconds: BigInt(Math.floor(Date.now() / 1000) + 60), isCurrent: current });
      f.items.set(full.item.seed, full.item);
      expect((await openEvidence({ ...input, record: full.record, expectedRecordHash: full.recordHash, assignment: full.record.assignment })).report.missing).toEqual([]);
    }
    expect(verifyEvidence([f.prepared.opening, message.opening], expected, f.order).missing).toEqual([]);
    expect(() => verifyEvidence([message.opening, f.prepared.opening], expected, f.order)).toThrow("sequence");
    expect(() => verifyEvidence([{ ...f.prepared.opening, payload: { text: "tampered", tickets: [] } }], expected, f.order)).toThrow("commitments");
    const badRecord = { ...f.prepared.record, buyerEnvelope: f.prepared.record.sellerEnvelope };
    expect(recordHash(badRecord)).not.toBe(f.prepared.recordHash);
  });
});
