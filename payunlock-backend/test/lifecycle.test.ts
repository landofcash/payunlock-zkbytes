import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChainService, escrowInterface } from "../src/services/chain-service.js";
import { lifecycleRequest, lifecycleSchema } from "../src/services/lifecycle-actions.js";
import type { ChainSnapshot } from "../src/domain.js";
const buyer = `0x${"11".repeat(20)}`, seller = `0x${"22".repeat(20)}`, arb = `0x${"33".repeat(20)}`, hash = `0x${"44".repeat(32)}`;
const reference = { serviceId: 1, preparedAt: "1", creator: hash, buyerEnvelope: `0x03${"11".repeat(64)}`, sellerEnvelope: `0x03${"22".repeat(64)}`, contentHash: hash };
let snapshot: ChainSnapshot, chain: ChainService;
beforeEach(() => {
  snapshot = { canceled: false, block: { number: 1, hash, timestamp: 100 }, order: { state: 1, buyer, seller, productKey: hash, requestId: hash, buyerReceiving: { nonce: hash, publicKey: hash }, sellerReceiving: { nonce: hash, publicKey: hash }, terms: { token: buyer, price: "1", hasEventEnd: false, eventEnd: "0", reviewWindow: "60", responseWindow: "60", commitmentWindow: "60" }, deliveryHash: hash, publicationDeadline: "200", reviewDeadline: "200", responseDeadline: "200", turn: "1" } };
  chain = new ChainService("https://unused.invalid");
  vi.spyOn(chain, "anchor").mockResolvedValue(snapshot.block); vi.spyOn(chain, "ensureCanonical").mockResolvedValue();
  vi.spyOn(chain, "order").mockImplementation(async () => snapshot);
  vi.spyOn(chain, "orders").mockImplementation(async ids => ids.map(() => snapshot));
  vi.spyOn(chain, "call").mockImplementation(async name => [name === "owner" ? seller : hash] as never);
});
describe("lifecycle preparation boundaries", () => {
  it("bounds batches dynamically, rejects duplicates and mixed sellers, and encodes all stable IDs", async () => {
    vi.mocked(chain.call).mockImplementation(async name => [name === "batchLimit" ? 2 : hash] as never);
    const action = { kind: "reserveDeliveries" as const, items: [{ orderId: "1" }, { orderId: "2" }] };
    const result = await lifecycleRequest(chain, seller, action);
    expect(escrowInterface.parseTransaction({ data: result.data })!.args[0].map(String)).toEqual(["1", "2"]);
    await expect(lifecycleRequest(chain, seller, { ...action, items: [action.items[0]!, action.items[0]!] })).rejects.toMatchObject({ code: "ACTION_NOT_AVAILABLE" });
    await expect(lifecycleRequest(chain, buyer, action)).rejects.toMatchObject({ code: "ACTION_NOT_AVAILABLE" });
    vi.mocked(chain.call).mockResolvedValue([1] as never);
    await expect(lifecycleRequest(chain, seller, action)).rejects.toMatchObject({ code: "ACTION_NOT_AVAILABLE" });
  });
  it("refunds only canceled unpublished orders and cancels through the public product getter", async () => {
    vi.mocked(chain.call).mockImplementation(async name => [name === "getProduct" ? { status: 1 } : 30] as never);
    expect(escrowInterface.parseTransaction({ data: (await lifecycleRequest(chain, seller, { kind: "cancelProduct", productKey: hash })).data })!.name).toBe("cancelProduct");
    const action = { kind: "refundCanceledOrders" as const, orderIds: ["1"] };
    await expect(lifecycleRequest(chain, seller, action)).rejects.toMatchObject({ code: "ACTION_NOT_AVAILABLE" });
    snapshot.canceled = true;
    for (const state of [1, 2]) { snapshot.order.state = state; await expect(lifecycleRequest(chain, seller, action)).resolves.toBeDefined(); }
    for (const state of [3, 4, 5, 6, 7, 8, 9]) { snapshot.order.state = state; await expect(lifecycleRequest(chain, seller, action)).rejects.toMatchObject({ code: "ACTION_NOT_AVAILABLE" }); }
  });
  it("requires successful finality and matching references for every publication in the batch", async () => {
    vi.mocked(chain.call).mockImplementation(async name => [name === "batchLimit" ? 30 : hash] as never);
    vi.spyOn(chain, "batchPublication").mockResolvedValue([true, true]);
    const action = { kind: "publishDeliveries" as const, items: [{ orderId: "1", reference, reservationTransaction: hash }, { orderId: "2", reference, reservationTransaction: hash }] };
    await expect(lifecycleRequest(chain, seller, action)).resolves.toBeDefined();
    vi.mocked(chain.batchPublication).mockResolvedValue([true, false]);
    await expect(lifecycleRequest(chain, seller, action)).rejects.toMatchObject({ code: "ACTION_NOT_AVAILABLE" });
  });
  it("only commits a paid, uncanceled order for its seller", async () => {
    const action = { kind: "reserveDelivery" as const, orderId: "1" };
    await expect(lifecycleRequest(chain, buyer, action)).rejects.toMatchObject({ code: "ACTION_NOT_AVAILABLE" });
    expect(escrowInterface.decodeFunctionData("reserveDelivery", (await lifecycleRequest(chain, seller, action)).data)[0]).toBe(1n);
    snapshot.canceled = true; await expect(lifecycleRequest(chain, seller, action)).rejects.toThrow();
    snapshot.canceled = false; snapshot.order.state = 2; await expect(lifecycleRequest(chain, seller, action)).rejects.toThrow();
  });
  it("never publishes before successful canonical TX1 finality or with another record", async () => {
    const action = { kind: "publishDelivery" as const, orderId: "1", reference, reservationTransaction: hash };
    const check = vi.spyOn(chain, "publication").mockResolvedValue({ eligible: false, reason: "provisional" });
    await expect(lifecycleRequest(chain, seller, action)).rejects.toThrow();
    check.mockResolvedValue({ eligible: true, reason: "finalized_commitment", checkedBlock: 1, publicationDeadline: "200" });
    const tx = await lifecycleRequest(chain, seller, action);
    expect(escrowInterface.decodeFunctionData("publishDelivery", tx.data)[1].contentHash).toBe(hash);
    snapshot.order.deliveryHash = `0x${"55".repeat(32)}`;
    await expect(lifecycleRequest(chain, seller, action)).resolves.toBeDefined();
  });
  it("rejects stale turns, wrong participants, and replies at the deadline", async () => {
    snapshot.order.state = 4;
    const action = { kind: "replyToDispute" as const, orderId: "1", expectedTurn: "2", reference };
    await lifecycleRequest(chain, seller, action);
    await expect(lifecycleRequest(chain, buyer, action)).rejects.toThrow();
    await expect(lifecycleRequest(chain, seller, { ...action, expectedTurn: "1" })).rejects.toThrow();
    snapshot.block.timestamp = 200; await expect(lifecycleRequest(chain, seller, action)).rejects.toThrow();
  });
  it("binds arbitration fee and rejects voluntary settlement during arbitration", async () => {
    snapshot.order.state = 4;
    const tx = await lifecycleRequest(chain, buyer, { kind: "requestArbitration", orderId: "1", wallet: arb, expectedKeyVersion: "1", expectedFee: "25", evidence: { contentRef: reference, arbitratorEnvelope: reference.buyerEnvelope } });
    expect(tx.value).toBe("25");
    snapshot.order.state = 6;
    await expect(lifecycleRequest(chain, buyer, { kind: "confirmReceipt", orderId: "1" })).rejects.toThrow();
    await expect(lifecycleRequest(chain, seller, { kind: "refundDisputedOrder", orderId: "1" })).rejects.toThrow();
  });
  it("revokes old assignments and permits current arbitrator decisions without handover", async () => {
    snapshot.order.state = 6; snapshot.assignment = { wallet: arb, publicKey: hash, keyVersion: "2", revision: "2", fee: "25", requester: buyer, handoverRecorded: false };
    const action = { kind: "resolveArbitration" as const, orderId: "1", revision: "2", sellerWins: false };
    await lifecycleRequest(chain, arb, action);
    await expect(lifecycleRequest(chain, seller, action)).rejects.toThrow();
    await expect(lifecycleRequest(chain, arb, { ...action, revision: "1" })).rejects.toThrow();
    await expect(lifecycleRequest(chain, buyer, { kind: "setDefaultReviewWindow", value: "0" })).rejects.toThrow();
    expect(escrowInterface.decodeFunctionData("setDefaultReviewWindow", (await lifecycleRequest(chain, seller, { kind: "setDefaultReviewWindow", value: "0" })).data)[0]).toBe(0n);
  });
  it("bounds public references and refuses plaintext fields", () => {
    expect(lifecycleSchema.safeParse({ kind: "openDispute", orderId: "1", reference: { ...reference, seed: "SECRET" } }).success).toBe(false);
    expect(lifecycleSchema.safeParse({ kind: "openDispute", orderId: "1", reference: { ...reference, buyerEnvelope: "0x" } }).success).toBe(false);
  });
});


it("encodes all configuration actions only for the owner", async () => {
  const actions = [{ kind: "addStorageService", serviceId: 2 }, { kind: "setBatchLimit", value: "1" }, { kind: "setResponseWindow", value: "120" }, { kind: "setTimingBounds", responseFloor: "60", commitmentFloor: 10, commitmentCeiling: 300 }];
  for (const input of actions) {
    const action = lifecycleSchema.parse(input);
    await expect(lifecycleRequest(chain, buyer, action)).rejects.toMatchObject({ code: "ACTION_NOT_AVAILABLE" });
    expect(escrowInterface.parseTransaction({ data: (await lifecycleRequest(chain, seller, action)).data })!.name).toBe(input.kind);
  }
  expect(lifecycleSchema.safeParse({ kind: "openDispute", orderId: "1", reference: { ...reference, serviceId: 2 } }).success).toBe(true);
  expect(lifecycleSchema.safeParse({ kind: "openDispute", orderId: "1", reference: { ...reference, serviceId: 4294967296 } }).success).toBe(false);
});

it("restricts payment asset changes to the owner and encodes enable and disable exactly", async () => {
  for (const allowed of [true, false]) {
    const action = lifecycleSchema.parse({ kind: "setAllowedAsset", asset: arb, allowed });
    await expect(lifecycleRequest(chain, buyer, action)).rejects.toMatchObject({ code: "ACTION_NOT_AVAILABLE" });
    const result = await lifecycleRequest(chain, seller, action);
    const decoded = escrowInterface.decodeFunctionData("setAllowedAsset", result.data);
    expect(decoded[0].toLowerCase()).toBe(arb); expect(decoded[1]).toBe(allowed); expect(result.value).toBe("0");
  }
  expect(lifecycleSchema.safeParse({ kind: "setAllowedAsset", asset: "invalid", allowed: true }).success).toBe(false);
  expect(lifecycleSchema.safeParse({ kind: "setAllowedAsset", asset: arb, allowed: "false" }).success).toBe(false);
});
