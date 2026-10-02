import { describe, expect, it, vi } from "vitest";
import { ApiError, type ChainSnapshot } from "../src/domain.js";
import { ChainService, deployment, eligibility, escrowAddress, escrowInterface } from "../src/services/chain-service.js";
import { Interface } from "ethers";
const hash = `0x${"11".repeat(32)}`, otherHash = `0x${"22".repeat(32)}`;
const wallet = "0x1111111111111111111111111111111111111111";
const response = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
function fixture(overrides: Record<string, unknown> = {}) {
  const receipt = { status: "0x1", blockNumber: "0x10", blockHash: hash, transactionHash: hash, from: wallet, to: escrowAddress, logs: [] };
  const rpc = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: string[] };
    if (method in overrides) return response(overrides[method]);
    if (method === "eth_chainId") return response("0x279f");
    if (method === "eth_getBlockByNumber") return response({ number: params[0] === "finalized" ? "0x20" : params[0], hash, timestamp: "0x100" });
    if (method === "eth_getTransactionReceipt") return response(receipt);
    throw new Error("Unexpected method");
  });
  return { chain: new ChainService("https://secret.example.invalid/key", rpc as typeof fetch), rpc, receipt };
}
describe("finality and failure boundaries", () => {
  it.each(["direct", "relayed"])("recovers the accepted checkout commitment from a finalized %s purchase", async mode => {
    const { chain, receipt } = fixture();
    const receiving = { nonce: hash, publicKey: otherHash };
    const order = { buyer: wallet, seller: escrowAddress, productKey: hash, requestId: otherHash, buyerReceiving: receiving } as ChainSnapshot["order"];
    const eventOrder = [1, wallet, escrowAddress, hash, otherHash, receiving, receiving,
      [escrowAddress, 1000, false, 0, 100, 100, 100], otherHash, 0, 0, 0, 0];
    const event = escrowInterface.encodeEventLog(escrowInterface.getEvent("Purchased")!, [1, wallet, otherHash, eventOrder]);
    const directInput = escrowInterface.encodeFunctionData("purchase", [escrowAddress, hash, otherHash, hash, receiving]);
    const router = new Interface(["function purchaseWithAuthorization((address seller,bytes32 productKey,bytes32 requestId,bytes32 expectedCheckoutHash,(bytes32 nonce,bytes32 publicKey) receiving) intent,(address actor,uint256 validAfter,uint256 validBefore,bytes32 salt,bytes signature) auth)"]);
    const relayedInput = router.encodeFunctionData("purchaseWithAuthorization", [[escrowAddress, hash, otherHash, hash, receiving], [wallet, 0, 100, hash, "0x"]]);
    const result = { ...receipt, logs: [{ address: escrowAddress, ...event }] };
    const tx = { hash, blockHash: receipt.blockHash, from: mode === "direct" ? wallet : escrowAddress,
      to: mode === "direct" ? escrowAddress : deployment.router, input: mode === "direct" ? directInput : relayedInput };
    const rpc = vi.spyOn(chain, "rpc");
    rpc.mockImplementation(async <T>(method: string, params: unknown[]): Promise<T> => {
      if (method === "eth_chainId") return "0x279f" as T;
      if (method === "eth_getBlockByNumber") return { number: params[0] === "finalized" ? "0x20" : params[0], hash: receipt.blockHash, timestamp: "0x100" } as T;
      if (method === "eth_getTransactionReceipt") return result as T;
      if (method === "eth_getTransactionByHash") return tx as T;
      throw new Error("Unexpected RPC");
    });
    expect(await chain.purchaseCheckoutHash("1", order, hash)).toBe(hash);
    // Never use current fee settings to reconstruct the purchased commitment.
    expect(rpc.mock.calls.some(([method]) => method === "eth_call")).toBe(false);
    expect(await chain.purchaseCheckoutHash("2", order, hash)).toBeNull();
    expect(await chain.purchaseCheckoutHash("1", { ...order, buyerReceiving: { ...receiving, nonce: otherHash } }, hash)).toBeNull();
    tx.input = directInput;
    tx.to = "0x3333333333333333333333333333333333333333";
    expect(await chain.purchaseCheckoutHash("1", order, hash)).toBeNull();
    tx.to = escrowAddress; tx.from = wallet;
    result.blockHash = otherHash;
    expect(await chain.purchaseCheckoutHash("1", order, hash)).toBeNull();
    result.blockHash = receipt.blockHash; result.blockNumber = "0x21";
    expect(await chain.purchaseCheckoutHash("1", order, hash)).toBeNull();
  });
  it("checks a shared batch receipt once and rejects expired, canceled, mismatched or missing commitments", async () => {
    const { chain, receipt } = fixture();
    const iface = new Interface(["event DeliveryReserved(uint256 indexed orderId,uint64 publicationDeadline)"]);
    const logs = [1, 2].map(id => ({ ...iface.encodeEventLog(iface.getEvent("DeliveryReserved")!, [id, 200]), address: escrowAddress }));
    vi.spyOn(chain, "transaction").mockResolvedValue({ status: "finalized_success", blockNumber: 16, blockHash: hash, receipt: { ...receipt, logs } });
    const snapshot = { block: { number: 32, hash, timestamp: 100 }, canceled: false, order: { state: 2, seller: wallet, deliveryHash: hash, publicationDeadline: "200" } } as ChainSnapshot;
    vi.spyOn(chain, "orders").mockResolvedValue([snapshot, snapshot]);
    const items = ["1", "2"].map(orderId => ({ orderId, reservationTransaction: hash }));
    expect(await chain.batchPublication(items, wallet, [snapshot, snapshot])).toEqual([true, true]);
    expect(chain.transaction).toHaveBeenCalledOnce();
    expect(await chain.batchPublication(items, wallet, [snapshot, { ...snapshot, canceled: true }])).toEqual([true, false]);
    expect(await chain.batchPublication(items, wallet, [snapshot, { ...snapshot, block: { ...snapshot.block, timestamp: 200 } }])).toEqual([true, false]);
    expect(await chain.batchPublication([{ orderId: "3", reservationTransaction: hash }], wallet, [snapshot])).toEqual([false]);
    vi.mocked(chain.transaction).mockResolvedValue({ status: "provisional" });
    expect(await chain.batchPublication(items, wallet, [snapshot, snapshot])).toEqual([false, false]);
  });
  it("keeps null receipts uncertain, even when finalized blocks are available", async () => {
    const { chain } = fixture({ eth_getTransactionReceipt: null });
    expect(await chain.transaction(hash, wallet)).toEqual({ status: "uncertain" });
  });
  it("requires canonical receipt block hash and exact transaction ownership", async () => {
    const { receipt } = fixture();
    expect((await fixture({ eth_getTransactionReceipt: { ...receipt, blockHash: otherHash } }).chain.transaction(hash, wallet)).status).toBe("uncertain");
    await expect(fixture({ eth_getTransactionReceipt: { ...receipt, from: escrowAddress } }).chain.transaction(hash, wallet)).rejects.toMatchObject({ statusCode: 403 });
    expect((await fixture({ eth_getTransactionReceipt: { ...receipt, status: "0x0" } }).chain.transaction(hash, wallet)).status).toBe("finalized_revert");
  });
  it("accepts only the seller's finalized router reservation for publication", async () => {
    const { receipt } = fixture();
    const router = new Interface(["event ActionExecuted(address indexed actor,bytes32 indexed nonce,bytes4 indexed selector,bytes32 actionHash)"]);
    const reservation = new Interface(["event DeliveryReserved(uint256 indexed orderId,uint64 publicationDeadline)"]);
    const routerLog = (actor: string, selector: string) => ({ ...router.encodeEventLog(router.getEvent("ActionExecuted")!, [actor, hash, selector, hash]), address: deployment.router! });
    const reserved = { ...reservation.encodeEventLog(reservation.getEvent("DeliveryReserved")!, [5, 200]), address: escrowAddress };
    const relayed = { ...receipt, from: "0x2222222222222222222222222222222222222222", to: deployment.router!, logs: [routerLog(wallet, escrowInterface.getFunction("reserveDeliveries")!.selector), reserved] };
    const snapshot = { block: { number: 32, hash, timestamp: 100 }, canceled: false, order: { state: 2, seller: wallet, publicationDeadline: "200" } } as ChainSnapshot;
    const accepted = fixture({ eth_getTransactionReceipt: relayed }).chain;
    vi.spyOn(accepted, "orders").mockResolvedValue([snapshot]);
    expect(await accepted.batchPublication([{ orderId: "5", reservationTransaction: hash }], wallet, [snapshot])).toEqual([true]);
    await expect(accepted.transaction(hash, wallet)).rejects.toMatchObject({ code: "TRANSACTION_NOT_OWNED" });
    for (const logs of [[routerLog("0x3333333333333333333333333333333333333333", escrowInterface.getFunction("reserveDeliveries")!.selector), reserved],
      [routerLog(wallet, escrowInterface.getFunction("publishDeliveries")!.selector), reserved], [reserved]]) {
      const chain = fixture({ eth_getTransactionReceipt: { ...relayed, logs } }).chain;
      vi.spyOn(chain, "orders").mockResolvedValue([snapshot]);
      await expect(chain.batchPublication([{ orderId: "5", reservationTransaction: hash }], wallet, [snapshot])).rejects.toMatchObject({ code: "TRANSACTION_NOT_OWNED" });
    }
  });
  it("does not accept a receipt above the finalized height", async () => {
    const { receipt } = fixture();
    expect((await fixture({ eth_getTransactionReceipt: { ...receipt, blockNumber: "0x21" } }).chain.transaction(hash, wallet)).status).toBe("provisional");
  });
  it("sanitizes provider failures and rejects the wrong chain", async () => {
    await expect(fixture({ eth_chainId: "0x1" }).chain.anchor()).rejects.toMatchObject({ code: "WRONG_CHAIN" });
    const chain = new ChainService("https://secret.invalid/key", async () => { throw new Error("secret-key"); });
    await expect(chain.anchor()).rejects.toEqual(new ApiError(503, "CHAIN_UNAVAILABLE"));
  });
  it("computes timeout rights at equality without waiting for another event", () => {
    const snapshot = { block: { timestamp: 100 }, canceled: false, order: { state: 4, buyer: wallet, seller: escrowAddress, responseDeadline: "100", publicationDeadline: "0", reviewDeadline: "0" } } as ChainSnapshot;
    expect(eligibility(snapshot, wallet)).toMatchObject({ claimResponseTimeout: true, requestArbitration: false, confirmReceipt: false });
    expect(eligibility(snapshot, escrowAddress)).toMatchObject({ reply: false, refundDisputedOrder: true });
  });
  it("only enables TX2 for a finalized matching TX1 and fresh uncanceled unexpired state", async () => {
    const { chain, receipt } = fixture();
    const iface = new Interface(["event DeliveryReserved(uint256 indexed orderId,uint64 publicationDeadline)"]);
    const log = iface.encodeEventLog(iface.getEvent("DeliveryReserved")!, [1, 200]);
    const receiptResult = { status: "finalized_success" as const, blockNumber: 16, blockHash: hash, receipt: { ...receipt, logs: [{ ...log, address: escrowAddress }] } };
    vi.spyOn(chain, "transaction").mockResolvedValue(receiptResult);
    const snapshot = { block: { number: 32, hash, timestamp: 100 }, canceled: false, order: { state: 2, seller: wallet, deliveryHash: hash, publicationDeadline: "200" } } as ChainSnapshot;
    vi.spyOn(chain, "order").mockResolvedValue(snapshot);
    expect((await chain.publication("1", hash, wallet)).eligible).toBe(true);
    vi.mocked(chain.order).mockImplementation(async (_id, tag) => tag === "latest" ? { ...snapshot, canceled: true } : snapshot);
    expect((await chain.publication("1", hash, wallet)).eligible).toBe(false);
    vi.mocked(chain.order).mockResolvedValue({ ...snapshot, block: { ...snapshot.block, timestamp: 200 } });
    expect((await chain.publication("1", hash, wallet)).eligible).toBe(false);
    vi.mocked(chain.order).mockResolvedValue({ ...snapshot, order: { ...snapshot.order, publicationDeadline: "201" } });
    expect((await chain.publication("1", hash, wallet)).eligible).toBe(false);
    vi.mocked(chain.transaction).mockResolvedValue({ status: "provisional" });
    expect((await chain.publication("1", hash, wallet)).eligible).toBe(false);
  });
  it("keeps a disappearing or changed receipt uncertain after the canonical lookup", async () => {
    const { chain, rpc, receipt } = fixture();
    let reads = 0;
    rpc.mockImplementation(async (_url, init) => {
      const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: string[] };
      if (method === "eth_chainId") return response("0x279f");
      if (method === "eth_getBlockByNumber") return response({ number: params[0] === "finalized" ? "0x20" : params[0], hash, timestamp: "0x100" });
      return response(++reads === 1 ? receipt : null);
    });
    expect((await chain.transaction(hash, wallet)).status).toBe("uncertain");
  });
});
