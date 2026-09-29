import { describe, expect, it, vi } from "vitest";
import { reconcileAction } from "../commerce/reconcile";
const account = `0x${"11".repeat(20)}`, hash = `0x${"22".repeat(32)}`;
const reference = { serviceId: 1, preparedAt: "1", creator: hash, buyerEnvelope: `0x03${"33".repeat(64)}`, sellerEnvelope: `0x03${"44".repeat(64)}`, contentHash: hash };
describe("lost-response lifecycle reconciliation", () => {
  it("only recovers a matching finalized seller commitment", async () => {
    const api = { request: vi.fn().mockResolvedValue({ order: { seller: account, state: 2, publicationDeadline: "100" } }) };
    expect(await reconcileAction(api, account, { kind: "reserveDelivery", orderId: "1" })).toBe(true);
    expect(await reconcileAction(api, "other", { kind: "reserveDelivery", orderId: "1" })).toBe(false);
    api.request.mockResolvedValue({ order: { seller: account, state: 1, publicationDeadline: "0" } });
    expect(await reconcileAction(api, account, { kind: "reserveDelivery", orderId: "1" })).toBe(false);
  });
  it("binds recovered messages to the original sender, turn, and full encrypted reference", async () => {
    const row = { turn: "2", sender: account, reference };
    const api = { request: vi.fn().mockImplementation(async (path: string) => path.includes("records") ? { items: [row] } : { order: {} }) };
    const action = { kind: "replyToDispute" as const, orderId: "1", expectedTurn: "2", reference };
    expect(await reconcileAction(api, account, action)).toBe(true);
    expect(await reconcileAction(api, account, { ...action, expectedTurn: "3" })).toBe(false);
    expect(await reconcileAction(api, account, { ...action, reference: { ...reference, contentHash: `0x${"55".repeat(32)}` } })).toBe(false);
    row.sender = `0x${"99".repeat(20)}`;
    expect(await reconcileAction(api, account, action)).toBe(false);
  });
  it("recovers exactly the submitted evidence across pages, not a different assignment", async () => {
    const evidence = { contentRef: reference, arbitratorEnvelope: reference.buyerEnvelope };
    const api = { request: vi.fn().mockImplementation(async (path: string) => path.includes("after") ? { items: [{ submitter: account, revision: "2", data: evidence }], nextCursor: null } : path.includes("evidence") ? { items: [], nextCursor: "0" } : { order: {} }) };
    expect(await reconcileAction(api, account, { kind: "submitArbitrationEvidence", orderId: "1", revision: "2", evidence })).toBe(true);
    expect(await reconcileAction(api, account, { kind: "submitArbitrationEvidence", orderId: "1", revision: "1", evidence })).toBe(false);
  });
  it("recovers only the exact finalized encrypted request and keeps index lag uncertain", async () => {
    const request = { contentRef: reference, arbitratorEnvelope: reference.buyerEnvelope };
    const action = { kind: "requestArbitrationEvidence" as const, orderId: "1", revision: "2", expectedIndex: "3", participant: account, advisoryDate: "0", request };
    const row = { index: "3", revision: "2", participant: account, advisoryDate: "0", assignment: { wallet: account }, data: request };
    const api = { request: vi.fn().mockImplementation(async (path: string) => path.includes("evidence-requests") ? { items: [row] } : { order: {} }) };
    expect(await reconcileAction(api, account, action)).toBe(true);
    expect(await reconcileAction(api, account, { ...action, expectedIndex: "4" })).toBe(false);
    expect(await reconcileAction(api, account, { ...action, revision: "1" })).toBe(false);
    api.request.mockImplementation(async (path: string) => path.includes("evidence-requests") ? { items: [] } : { order: {} });
    expect(await reconcileAction(api, account, action)).toBe(false);
  });
});
