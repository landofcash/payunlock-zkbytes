import { describe, expect, it } from "vitest";
import { createTestIndexer, type TestIndexerProcessConfig } from "envio";
import { OrderState, encode } from "../src/handlers/escrow.js";

import { readFileSync } from "node:fs";
const config = readFileSync(new URL("../config.yaml", import.meta.url), "utf8");
const escrow = config.match(/address: "(0x[0-9a-fA-F]+)"/)![1]!.toLowerCase() as `0x${string}`;
const startBlock = Number(config.match(/start_block: (\d+)/)![1]);
const buyer = "0x1111111111111111111111111111111111111111" as const;
const seller = "0x2222222222222222222222222222222222222222" as const;
const arb = "0x3333333333333333333333333333333333333333" as const;
const replacement = "0x4444444444444444444444444444444444444444" as const;
const key = `0x${"11".repeat(32)}`;
const hash = `0x${"22".repeat(32)}`;
const zero = `0x${"00".repeat(32)}`;
const address0 = "0x0000000000000000000000000000000000000000" as const;
const receiving = { nonce: key, publicKey: hash };
const terms = { token: address0, price: 900719925474099312345n, hasEventEnd: false, eventEnd: 0n, reviewWindow: 86400n, responseWindow: 259200n, commitmentWindow: 600n };
const order = { state: 1n, buyer, seller, productKey: key, requestId: hash, buyerReceiving: receiving, sellerReceiving: receiving,
  terms, deliveryHash: zero, publicationDeadline: 0n, reviewDeadline: 0n, responseDeadline: 0n, turn: 0n };
const contentRef = { serviceId: 1n, preparedAt: 1700000000n, creator: key, buyerEnvelope: `0x03${"11".repeat(64)}`, sellerEnvelope: `0x03${"22".repeat(64)}`, contentHash: hash };
const assignment = { wallet: arb, publicKey: key, keyVersion: 1n, revision: 1n, fee: 15n, requester: buyer, handoverRecorded: false };
type Simulate = NonNullable<NonNullable<TestIndexerProcessConfig["chains"][10143]>["simulate"]>;
const events: Simulate = [
  { contract: "PayUnlock", event: "StorageServiceAdded", params: { serviceId: 1n } },
  { contract: "PayUnlock", event: "StorageServiceAdded", params: { serviceId: 2n } },
  { contract: "PayUnlock", event: "BatchLimitChanged", params: { batchLimit: 30n } },
  { contract: "PayUnlock", event: "BatchLimitChanged", params: { batchLimit: 1n } },
  { contract: "PayUnlock", event: "TimingBoundsChanged", params: { minResponseWindow: 120n, minCommitmentWindow: 10n, maxCommitmentWindow: 300n } },
  { contract: "PayUnlock", event: "ProductConfigured", params: { seller, key, product: { status: 1n, terms: { token: address0, price: terms.price, hasEventEnd: false, eventEnd: 0n, hasReviewOverride: false, reviewOverride: 0n, commitmentWindow: 600n }, receiving, orderCount: 0n } } },
  { contract: "PayUnlock", event: "Purchased", params: { orderId: 1n, buyer, requestId: hash, order } },
  { contract: "PayUnlock", event: "Purchased", params: { orderId: 2n, buyer, requestId: key, order: { ...order, requestId: key } } },
  { contract: "PayUnlock", event: "DeliveryReserved", params: { orderId: 1n, publicationDeadline: 1700000600n } },
  { contract: "PayUnlock", event: "RecordPublished", params: { orderId: 1n, sequence: 0n, author: seller, recordHash: hash, contentRef } },
  { contract: "PayUnlock", event: "StateChanged", params: { orderId: 1n, state: 3n, deadline: 1700086400n } },
  { contract: "PayUnlock", event: "RecordPublished", params: { orderId: 1n, sequence: 1n, author: buyer, recordHash: hash, contentRef } },
  { contract: "PayUnlock", event: "StateChanged", params: { orderId: 1n, state: 4n, deadline: 1700259200n } },
  { contract: "PayUnlock", event: "RecordPublished", params: { orderId: 1n, sequence: 2n, author: seller, recordHash: hash, contentRef } },
  { contract: "PayUnlock", event: "StateChanged", params: { orderId: 1n, state: 5n, deadline: 1700259300n } },
  { contract: "PayUnlock", event: "ArbitratorConfigured", params: { arbitrator: arb, configuration: { active: true, publicKey: key, keyVersion: 1n, fee: 15n } } },
  { contract: "PayUnlock", event: "ArbitrationAssigned", params: { orderId: 1n, assignment, reason: zero } },
  { contract: "PayUnlock", event: "EvidencePublished", params: { orderId: 1n, index: 0n, submitter: buyer, revision: 1n, recordHash: hash, evidence: { contentRef, arbitratorEnvelope: contentRef.buyerEnvelope } } },
  { contract: "PayUnlock", event: "EvidenceRequested", params: { orderId: 1n, requestIndex: 0n, revision: 1n, participant: seller, recordHash: hash, assignment, request: { contentRef, arbitratorEnvelope: contentRef.buyerEnvelope }, advisoryDate: 9999999999n } },
  { contract: "PayUnlock", event: "ArbitrationAssigned", params: { orderId: 1n, assignment: { ...assignment, wallet: replacement, revision: 2n }, reason: hash } },
  { contract: "PayUnlock", event: "Settled", params: { orderId: 2n, recipient: buyer, asset: address0, amount: terms.price, state: 9n } },
];
const simulate = events.map((event, i) => ({ ...event, srcAddress: escrow, block: { number: startBlock + i, hash: `0x${(i + 1).toString(16).padStart(64, "0")}` }, logIndex: 0, transaction: { hash } }));
const id = `10143:${escrow}:1`;

describe("escrow event reconstruction", () => {
  it("preserves exact amounts, repeated buyers, turns, replacement authority and append-only evidence", async () => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 10143: { simulate } } });
    expect(JSON.parse((await indexer.ChainConfiguration.getOrThrow(`10143:${escrow}:StorageServiceAdded:1`)).data)).toEqual({ serviceId: 1 });
    expect(JSON.parse((await indexer.ChainConfiguration.getOrThrow(`10143:${escrow}:StorageServiceAdded:2`)).data)).toEqual({ serviceId: 2 });
    expect(JSON.parse((await indexer.ChainConfiguration.getOrThrow(`10143:${escrow}:BatchLimitChanged`)).data)).toEqual({ batchLimit: "1" });
    const row = await indexer.ChainOrder.getOrThrow(id);
    expect(row).toMatchObject({ price: terms.price, state: 6, turn: 2n, arbitrator: replacement, revision: 2n, handoverRecorded: false, responseDeadline: 1700259300n });
    expect(await indexer.ChainRecord.getAll()).toHaveLength(3);
    expect(await indexer.ChainEvidence.getAll()).toHaveLength(1);
    expect(await indexer.ChainEvidenceRequest.getAll()).toHaveLength(1);
    expect(await indexer.ChainOrder.getOrThrow(`10143:${escrow}:2`)).toMatchObject({ state: 9, buyer, requestId: key });
    expect(await indexer.ChainEvent.getAll()).toHaveLength(events.length);
    const rebuilt = createTestIndexer();
    await rebuilt.process({ chains: { 10143: { simulate } } });
    expect(await rebuilt.ChainOrder.getAll()).toEqual(await indexer.ChainOrder.getAll());
    expect(await rebuilt.ChainEvent.getAll()).toEqual(await indexer.ChainEvent.getAll());
  });
  it("handles supplement and full payout following replacement without losing original evidence", async () => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 10143: { simulate } } });
    await indexer.process({ chains: { 10143: { simulate: [
      { contract: "PayUnlock", event: "EvidencePublished", srcAddress: escrow, params: { orderId: 1n, index: 1n, submitter: seller, revision: 2n, recordHash: key, evidence: { contentRef, arbitratorEnvelope: contentRef.sellerEnvelope } } },
      { contract: "PayUnlock", event: "Settled", srcAddress: escrow, params: { orderId: 1n, recipient: seller, asset: address0, amount: terms.price, state: 8n } },
    ] } } });
    expect(await indexer.ChainOrder.getOrThrow(id)).toMatchObject({ state: OrderState.SettledToSeller, handoverRecorded: true, arbitrator: replacement });
    expect(await indexer.ChainEvidence.getAll()).toHaveLength(2);
  });
  it.each(["invalid json", '{"status":1}'])("rejects invalid product data during purchase: %s", async data => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 10143: { simulate: simulate.slice(0, 6) } } });
    const productId = `10143:${escrow}:${seller}:${key}`;
    const product = await indexer.ChainProduct.getOrThrow(productId);
    indexer.ChainProduct.set({ ...product, data });

    await expect(indexer.process({ chains: { 10143: { simulate: [simulate[6]!] } } })).rejects.toThrow();
    expect((await indexer.ChainProduct.getOrThrow(productId)).data).toBe(data);
  });
  it.each(["", "invalid json"])("rejects invalid arbitration data during evidence publication: %s", async invalidAssignment => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 10143: { simulate } } });
    const order = await indexer.ChainOrder.getOrThrow(id);
    indexer.ChainOrder.set({ ...order, assignment: invalidAssignment });

    await expect(indexer.process({ chains: { 10143: { simulate: [
      { contract: "PayUnlock", event: "EvidencePublished", srcAddress: escrow, params: { orderId: 1n, index: 1n, submitter: seller, revision: 2n, recordHash: key, evidence: { contentRef, arbitratorEnvelope: contentRef.sellerEnvelope } } },
    ] } } })).rejects.toThrow();
    expect(await indexer.ChainOrder.getOrThrow(id)).toMatchObject({ assignment: invalidAssignment, handoverRecorded: false });
  });
  it("encode serializes serviceId to number and bigints to string", () => {
    expect(encode({ serviceId: "12", count: 100n })).toBe('{"serviceId":12,"count":"100"}');
  });
});
