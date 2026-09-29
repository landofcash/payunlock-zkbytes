// @vitest-environment node
import { expect, it, vi } from "vitest";
import { Wallet } from "ethers";
import { clearItemKeys, encodeBase64, decryptStorageItem } from "@zkbytes/sdk";
import { newOfferReceivingContext, newReceivingContext, restoreReceiving, restoreReceivingKeys, prepareDelivery, openDelivery, type Order, type PreparedDelivery } from "../commerce/protocol";
import { deliveryRecord, reference } from "../commerce/lifecycle";
import { FulfillmentJournal } from "../commerce/journal";

const deployment = { chainId: 10143 as const, contract: `0x${"12".repeat(20)}` };
const offerId = "58c2aa55-6962-4390-b90e-86f4a5144eb6";
const current = () => true;
const latest = () => BigInt(Math.floor(Date.now() / 1000) + 60);

it("prepares 30 separate orders with one offer signature, restores seller access and isolates buyers", async () => {
  const seller = Wallet.createRandom(), buyers = [Wallet.createRandom(), Wallet.createRandom()];
  const identities = await Promise.all(buyers.map(b => restoreReceiving(newReceivingContext(deployment, b.address), b, current)));
  const signer = { address: seller.address, signMessage: vi.fn((message: string) => seller.signMessage(message)) };
  const context = newOfferReceivingContext(deployment, seller.address, offerId);
  const keys = await restoreReceivingKeys(context, signer, current);
  const sellerPublicKey = encodeBase64(keys.encryptionPublicKey);
  const deliveries: PreparedDelivery[] = [];
  try {
    for (let i = 0; i < 30; i++) {
      const b = identities[i % 2]!;
      const order: Order = { deployment, orderId: String(i + 1), buyer: { context: b.context, publicKey: b.publicKey }, seller: { context, publicKey: sellerPublicKey }, terms: { version: 1, token: `0x${"00".repeat(20)}`, price: "1", eventEnd: null, reviewWindow: "60", responseWindow: "60" } };
      deliveries.push(await prepareDelivery({ order, payload: { text: `Private code ${i}`, tickets: [] }, signer, offerKeys: keys, service: { id: 1, maxRetentionSeconds: 0, client: {} as never }, latestPublicationSeconds: latest(), isCurrent: current }));
    }
    expect(signer.signMessage).toHaveBeenCalledOnce();
    expect(new Set(deliveries.map(p => p.item.seed)).size).toBe(30);
    expect(new Set(deliveries.map(p => p.item.encryptedPayload)).size).toBe(30);
    expect(new Set(deliveries.map(p => p.item.creator.publicKey)).size).toBe(1);
    expect(deliveries.every(p => p.item.encryptedKeys.length === 2 && p.item.managers.length === 0)).toBe(true);
    for (const [i, p] of deliveries.entries()) {
      const b = identities[i % 2]!;
      const service = { id: 1, maxRetentionSeconds: 0, client: { downloadAndVerify: async () => p.item } as never };
      expect((await openDelivery({ record: p.record, expectedRecordHash: p.recordHash, order: p.record.order, role: "buyer", privateKey: b.privateKey, services: [service], isCurrent: current })).payload.text).toBe(`Private code ${i}`);
      await expect(decryptStorageItem(p.item, p.item.creator, identities[(i + 1) % 2]!.privateKey)).rejects.toThrow();
      const row = { turn: "0", commitment: p.recordHash, sender: seller.address.toLowerCase(), reference: reference(p.record) };
      expect(deliveryRecord(row, p.record.order)).toEqual(p.record);
    }
    // New browser: only the purchased context/public key and wallet are needed.
    clearItemKeys(keys);
    const restored = await restoreReceiving(context, seller, current, sellerPublicKey);
    try {
      const p = deliveries[0]!;
      const service = { id: 1, maxRetentionSeconds: 0, client: { downloadAndVerify: async () => p.item } as never };
      expect(await openDelivery({ record: p.record, expectedRecordHash: p.recordHash, order: p.record.order, role: "seller", privateKey: restored.privateKey, services: [service], isCurrent: current })).toEqual(p.opening);
      const records = new Map<string, unknown>();
      const store = { get: async (id: string) => records.get(id), put: async (id: string, value: unknown) => { records.set(id, value); }, remove: async (id: string) => { records.delete(id); }, compareAndSwap: async (id: string, before: unknown, next: unknown) => { expect(records.get(id)).toEqual(before); records.set(id, next); } };
      const journal = new FulfillmentJournal(store);
      const id = await journal.prepare(p, "a strong test passphrase", current);
      const backup = await journal.export(id);
      records.clear();
      await journal.import(backup, "a strong test passphrase");
      expect((await journal.restore(id, "a strong test passphrase")).item).toEqual(p.item);
      expect(signer.signMessage).toHaveBeenCalledOnce();
      expect(backup).not.toContain(p.item.seed);
    } finally { restored.privateKey.fill(0); }
  } finally { clearItemKeys(keys); identities.forEach(b => b.privateKey.fill(0)); }
}, 20000);

it("binds offer restoration to the seller, deployment and offer ID while preserving legacy receiving contexts", async () => {
  const seller = Wallet.createRandom();
  const context = newOfferReceivingContext(deployment, seller.address, offerId);
  expect(context.nonce).toBe(`0x${offerId.replaceAll("-", "").padStart(64, "0")}`);
  const first = await restoreReceivingKeys(context, seller, current);
  try {
    const publicKey = encodeBase64(first.encryptionPublicKey);
    await expect(restoreReceivingKeys({ ...context, nonce: `0x${"34".repeat(32)}` }, seller, current, publicKey)).rejects.toThrow("does not match");
    await expect(restoreReceivingKeys({ ...context, deployment: { ...deployment, contract: `0x${"56".repeat(20)}` } }, seller, current, publicKey)).rejects.toThrow("does not match");
    await expect(restoreReceivingKeys(context, Wallet.createRandom(), current, publicKey)).rejects.toThrow("Wrong receiving");
    const legacy = newReceivingContext(deployment, seller.address);
    const a = await restoreReceiving(legacy, seller, current);
    const b = await restoreReceivingKeys(legacy, seller, current, a.publicKey);
    try { expect(b.encryptionPrivateKey).toEqual(a.privateKey); }
    finally { a.privateKey.fill(0); clearItemKeys(b); }
  } finally { clearItemKeys(first); }
});
