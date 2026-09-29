// @vitest-environment node
import { expect, it } from "vitest";
import { Wallet } from "ethers";
import { openDelivery, prepareDelivery, restoreReceiving, recordHash, newReceivingContext, type Order } from "../commerce/protocol";
import { prepareRequest, openRequest, requestHash, verifyRequest, persistRequest, restoreRequest, type RequestRow } from "../commerce/requests";
import { prepareEvidence, openEvidence } from "../commerce/evidence";
import { storageService, arbitratorContext, deliveryRecord, evidenceRecord, evidenceReference, reference, assignment, hexKey, protocolOrder } from "../commerce/lifecycle";
import { canonical, commitment } from "../crypto/encoding";
import type { OrderView } from "../commerce/client";
it.each([1, 2])("service %i round trips the exact contract delivery and evidence encoding with independent wallet restoration", async (serviceId) => {
  const buyer = Wallet.createRandom(), seller = Wallet.createRandom(), arb = Wallet.createRandom();
  const deployment = { chainId: 10143 as const, contract: `0x${"12".repeat(20)}` };
  const b = await restoreReceiving(newReceivingContext(deployment, buyer.address), buyer, () => true);
  const s = await restoreReceiving(newReceivingContext(deployment, seller.address), seller, () => true);
  const a = await restoreReceiving(arbitratorContext(deployment, arb.address), arb, () => true);
  try {
    const order: Order = { deployment, orderId: "1", buyer: { context: b.context, publicKey: b.publicKey }, seller: { context: s.context, publicKey: s.publicKey }, terms: { version: 1, token: `0x${"00".repeat(20)}`, price: "1", eventEnd: null, reviewWindow: "60", responseWindow: "60" } };
    const p = await prepareDelivery({ order, payload: { text: "Private delivery", tickets: [] }, signer: seller, service: { id: serviceId, maxRetentionSeconds: 0, client: {} as never }, latestPublicationSeconds: BigInt(Math.floor(Date.now() / 1000) + 60), isCurrent: () => true });
    const deliveryService = { id: serviceId, maxRetentionSeconds: 0, client: { downloadAndVerify: async () => p.item } as never };
    expect(await openDelivery({ record: p.record, expectedRecordHash: p.recordHash, order, role: "buyer", privateKey: b.privateKey, services: [deliveryService], isCurrent: () => true })).toEqual(p.opening);
    await expect(openDelivery({ record: p.record, expectedRecordHash: p.recordHash, order, role: "buyer", privateKey: b.privateKey, services: [], isCurrent: () => true })).rejects.toThrow("Unknown storage");
    const row = { turn: "0", sender: seller.address.toLowerCase(), commitment: p.recordHash, reference: reference(p.record) };
    expect(canonical(deliveryRecord(row, order))).toBe(canonical(p.record));
    expect(recordHash(deliveryRecord(row, order))).toBe(p.recordHash);
    const target = assignment("1", { wallet: arb.address.toLowerCase(), revision: "2", keyVersion: "1", publicKey: hexKey(a.publicKey) });
    const e = await prepareEvidence({ originals: [p.opening], expected: [p.record.contentHash], order, assignment: target, unreadable: [], signer: buyer, serviceId, maxRetentionSeconds: 0, latestPublicationSeconds: BigInt(Math.floor(Date.now() / 1000) + 60), isCurrent: () => true });
    const encoded = evidenceReference(e);
    expect(encoded).not.toHaveProperty("originals"); expect(encoded).not.toHaveProperty("unreadable");
    expect(commitment("payunlock-evidence-record-v2", evidenceRecord(encoded, target, order))).toBe(e.recordHash);
    const service = { id: serviceId, maxRetentionSeconds: 0, client: { downloadAndVerify: async () => request.item } as never };
    const request = await prepareRequest({ order, assignment: target, index: "0", participant: b.context.account, advisoryDate: "0", sequences: ["0"], instructions: "Please provide the original", availableSequences: ["0"], signer: arb, service, isCurrent: () => true });
    const requestRow: RequestRow = { id: "request-0", index: "0", revision: "2", participant: b.context.account, advisoryDate: "0", commitment: request.recordHash, assignment: { wallet: target.wallet, publicKey: hexKey(a.publicKey), keyVersion: "1", revision: "2", fee: "0", requester: b.context.account, handoverRecorded: true }, data: evidenceReference({ record: request.record.reference } as typeof e) };
    for (const [role, identity] of [["buyer", b], ["seller", s], ["arbitrator", a]] as const) {
      const opened = await openRequest({ row: requestRow, order, role, privateKey: identity.privateKey, service, availableSequences: ["0"], isCurrent: () => true });
      expect(opened.content.instructions).toBe("Please provide the original");
    }
    expect(requestHash({ ...request.record, participant: s.context.account })).not.toBe(request.recordHash);
    expect(() => verifyRequest({ ...request, content: { ...request.content, instructions: "tampered" } }, request.recordHash, order, ["0"])).toThrow("integrity");
    expect(() => verifyRequest(request, request.recordHash, { ...order, orderId: "2" }, ["0"])).toThrow("integrity");
    expect(() => verifyRequest(request, request.recordHash, order, [])).toThrow("sequences");
    await expect(prepareRequest({ order, assignment: target, index: "1", participant: b.context.account, advisoryDate: "0", sequences: ["0", "0"], instructions: "", availableSequences: ["0"], signer: arb, service, isCurrent: () => true })).rejects.toThrow("sequences");
    const saved = new Map<string, unknown>();
    const store = { put: async (key: string, value: unknown) => { saved.set(key, value); }, get: async (key: string) => saved.get(key), compareAndSwap: async (key: string, before: unknown, next: unknown) => { if (saved.get(key) !== before) throw new Error("conflict"); saved.set(key, next); }, remove: async (key: string) => { saved.delete(key); } };
    await persistRequest(store, "request-draft", request, "a strong test passphrase", () => true);
    expect(JSON.stringify([...saved.values()])).not.toContain(request.item.seed);
    expect(await restoreRequest(store, "request-draft", "a strong test passphrase")).toEqual(request);
    const handover = await prepareEvidence({ originals: [], expected: [], order, assignment: { ...target, revision: "3" }, unreadable: [], requests: [{ record: request.record, content: request.content }], expectedRequests: [request.recordHash], availableSequences: ["0"], signer: buyer, serviceId, maxRetentionSeconds: 0, latestPublicationSeconds: BigInt(Math.floor(Date.now() / 1000) + 60), isCurrent: () => true });
    const handed = await openEvidence({ record: handover.record, expectedRecordHash: handover.recordHash, role: "arbitrator", privateKey: a.privateKey, serviceId, download: async () => handover.item, assignment: handover.record.assignment, order, expected: [], expectedRequests: [request.recordHash], availableSequences: ["0"], isCurrent: () => true });
    expect(handed.evidence.requests[0]!.record.reference.assignment.revision).toBe("2");
    await expect(openEvidence({ record: handover.record, expectedRecordHash: handover.recordHash, role: "arbitrator", privateKey: a.privateKey, serviceId, download: async () => handover.item, assignment: handover.record.assignment, order, expected: [], expectedRequests: [], availableSequences: ["0"], isCurrent: () => true })).rejects.toThrow("original finalized");
    const apiDeployment = { ...deployment, reviewWindow: "86400" };
    expect(protocolOrder({ orderId: "1", order: { buyer: b.context.account, seller: s.context.account, buyerReceiving: { nonce: b.context.nonce, publicKey: hexKey(b.publicKey) }, sellerReceiving: { nonce: s.context.nonce, publicKey: hexKey(s.publicKey) }, terms: { ...order.terms, hasEventEnd: false, eventEnd: "0" } } } as unknown as OrderView, apiDeployment)).toEqual(order);
    expect(arbitratorContext(apiDeployment, arb.address).deployment).toEqual(deployment);
    const restored = await restoreReceiving(arbitratorContext(deployment, arb.address), arb, () => true, a.publicKey);
    expect(restored.privateKey).toEqual(a.privateKey); restored.privateKey.fill(0);
  } finally { b.privateKey.fill(0); s.privateKey.fill(0); a.privateKey.fill(0); }
});


it("requires an explicit adapter for additional storage IDs", () => {
  const config = { id: 2, apiOrigin: "https://storage.test", downloadOrigin: "https://download.test", maxRetentionSeconds: 0 };
  expect(() => storageService(config)).toThrow("Unsupported");
  expect(storageService({ ...config, adapter: "zkbytes-v1" }).id).toBe(2);
  expect(() => storageService({ ...config, adapter: "zkbytes-v1", id: 0 })).toThrow("Unsupported");
});
