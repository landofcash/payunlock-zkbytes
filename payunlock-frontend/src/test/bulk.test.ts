import { BulkDeliverySession, DeliverySession } from "../commerce/delivery-session";
// @vitest-environment node
import { expect, it, vi } from "vitest";
import { Interface, Wallet } from "ethers";
import { encodeBase64, clearItemKeys } from "@zkbytes/sdk";
import { assignments, type BulkManifest, type BulkEntry } from "../commerce/bulk-content";
import { runBulkDelivery, runBulkRefunds, sendBatch, NotSubmitted, type BulkRuntime } from "../commerce/bulk-runner";
import { newOfferReceivingContext, newReceivingContext, restoreReceiving, restoreReceivingKeys, prepareDelivery, type Order } from "../commerce/protocol";
import { ApiError, type Action, type OrderView, type PreparedTx } from "../commerce/client";
import { hexKey, reference } from "../commerce/lifecycle";
import { deliveryApproval } from "../wallet/delivery-authorization";
import { WalletVault } from "../wallet/vault";
import { unlockWallet } from "../wallet/managed-session";

const deployment = { chainId: 10143 as const, contract: `0x${"12".repeat(20)}` }, productId = "58c2aa55-6962-4390-b90e-86f4a5144eb6", hash = `0x${"22".repeat(32)}`;
const memory = () => { const data = new Map<string, unknown>(); return { data, get: async (key: string) => data.get(key), put: async (key: string, value: unknown) => { data.set(key, structuredClone(value)); }, remove: async (key: string) => { data.delete(key); }, compareAndSwap: async (key: string, before: unknown, after: unknown) => { expect(data.get(key)).toEqual(before); data.set(key, structuredClone(after)); } }; };
const tx: PreparedTx = { chainId: 10143, to: deployment.contract, data: "0x1234", value: "0", gas: "100000", nonce: 0, maxFeePerGas: "10", maxPriorityFeePerGas: "1", balance: "10000000" };
async function fixture(count = 3) {
  const seller = Wallet.createRandom(), buyer = Wallet.createRandom(), ctx = newOfferReceivingContext(deployment, seller.address, productId), receiving = await restoreReceiving(newReceivingContext(deployment, buyer.address), buyer, () => true);
  const keys = await restoreReceivingKeys(ctx, seller, () => true);
  const orders: Order[] = Array.from({ length: count }, (_, i) => ({ deployment, orderId: String(i + 1), seller: { context: ctx, publicKey: encodeBase64(keys.encryptionPublicKey) }, buyer: { context: receiving.context, publicKey: receiving.publicKey }, terms: { version: 1, token: `0x${"00".repeat(20)}`, price: "1", eventEnd: null, reviewWindow: "60", responseWindow: "60" } }));
  const op: BulkManifest = { version: 1, kind: "delivery", id: crypto.randomUUID(), account: seller.address.toLowerCase(), deployment, productId, productKey: ctx.nonce, orderIds: orders.map(o => o.orderId), mode: "shared", createdAt: new Date().toISOString(), transactions: [], complete: false };
  const views = new Map(orders.map(o => [o.orderId, { orderId: o.orderId, canceled: false, block: { number: 1, hash, timestamp: Math.floor(Date.now() / 1000) }, order: { state: 1, seller: op.account, buyer: buyer.address.toLowerCase(), productKey: ctx.nonce, requestId: hash, terms: { ...o.terms, hasEventEnd: false, eventEnd: "0", commitmentWindow: "600" }, buyerReceiving: { nonce: receiving.context.nonce, publicKey: hexKey(receiving.publicKey) }, sellerReceiving: { nonce: ctx.nonce, publicKey: hexKey(o.seller.publicKey) }, deliveryHash: `0x${"00".repeat(32)}`, publicationDeadline: "0", reviewDeadline: "0", responseDeadline: "0", turn: "0" }, eligibility: {}, offer: { status: "public" } } as OrderView]));
  const entries = assignments(orders, "shared secret", "shared", "", new Map()), database = new Map(entries.map(e => [e.order.orderId, structuredClone(e)]));
  const storage = new Map<string, unknown>(), upload = vi.fn(async (item: { seed: string }) => { storage.set(item.seed, item); return {}; });
  const service = { id: 1, maxRetentionSeconds: 0, client: { recoverUpload: async (seed: string) => storage.has(seed) ? { outcome: "active", item: storage.get(seed) } : { outcome: "not-found" }, upload } };
  // Mock only transport and journal I/O. Protocol encryption and runner transitions are real.
  const journal = { entry: async (_id: string, id: string) => structuredClone(database.get(id)!), saveEntry: async (_id: string, e: BulkEntry) => { database.set(e.order.orderId, structuredClone(e)); }, save: vi.fn(async () => {}) } satisfies BulkRuntime["journal"];
  const pending = new Map<string, Action>(); let limit = 30, canceled = false;
  const request = vi.fn(async (path: string, body?: unknown): Promise<unknown> => {
    if (path === "/orders/batch") return { items: (body as { orderIds: string[] }).orderIds.map(id => structuredClone(views.get(id))) };
    if (/^\/orders\/\d+$/.test(path)) return structuredClone(views.get(path.split("/")[2]!));
    if (path.endsWith("/registration")) return { configuration: { status: canceled ? 3 : 1, productKey: op.productKey, contract: deployment.contract, seller: op.account } };
    if (path === "/transactions/prepare") {
      const a = body as Action, ids = "items" in a ? a.items.map(i => i.orderId) : "orderIds" in a ? a.orderIds : [];
      if (ids.length > limit) throw new ApiError("BATCH_GAS_LIMIT");
      return tx;
    }
    if (path === "/transactions/batch-status") return { status: "finalized_success" };
    if (path.includes("/records")) { const id = path.split("/")[2]!, e = database.get(id)!; return { items: e.prepared && views.get(id)!.order.state >= 3 ? [{ turn: "0", reference: reference(e.prepared.record) }] : [] }; }
    throw new Error(`Unexpected route ${path}`);
  });
  const send = vi.fn(async (_tx: PreparedTx, action: Action, remember: (hash: string) => Promise<void>) => {
    const txHash = `0x${String(pending.size + 1).padStart(64, "0")}`; await remember(txHash); pending.set(txHash, action);
    if (action.kind === "reserveDeliveries") for (const i of action.items) Object.assign(views.get(i.orderId)!.order, { state: 2, publicationDeadline: String(Math.floor(Date.now() / 1000) + 600) });
    if (action.kind === "publishDeliveries") for (const i of action.items) { views.get(i.orderId)!.order.state = 3; views.get(i.orderId)!.order.deliveryHash = database.get(i.orderId)!.prepared!.recordHash; }
    if (action.kind === "cancelProduct") { canceled = true; views.forEach(v => { v.canceled = true; }); }
    if (action.kind === "refundCanceledOrders") action.orderIds.forEach(id => { views.get(id)!.order.state = 9; });
  });
  const runtime: BulkRuntime = { journal, current: () => true, api: { request: request as BulkRuntime["api"]["request"], read: (async (path: string) => path === "/deployment" ? deployment : path === "/platform" ? { batchLimit: 30 } : { id: 1, apiOrigin: "https://api.test", downloadOrigin: "https://download.test", maxRetentionSeconds: 0 }) as BulkRuntime["api"]["read"] }, update: vi.fn(), sleep: async () => {}, send, prepare: vi.fn(async entry => prepareDelivery({ order: entry.order, payload: entry.payload, signer: seller, offerKeys: keys, service: service as never, latestPublicationSeconds: BigInt(Math.floor(Date.now() / 1000) + 600), isCurrent: () => true })) };
  return { seller, buyer, keys, receiving, orders, entries, op, views, database, runtime, request, send, upload, service, setLimit: (n: number) => { limit = n; }, close: () => { clearItemKeys(keys); receiving.privateKey.fill(0); } };
}
// Keep storage HTTP out of the transition tests; actual SDK storage is tested separately.
vi.mock("../commerce/lifecycle", async original => { const module = await original<typeof import("../commerce/lifecycle")>(); return { ...module, storageService: (config: unknown) => activeService ?? module.storageService(config as never) }; });
let activeService: unknown;

it("keeps repeated buyers distinct, rejects blank/mismatched rows, and makes tickets mutually exclusive", async () => {
  const f = await fixture(); try {
    const rows = assignments(f.orders, "hello", "rows", "a\tb\nsecond\nthird", new Map());
    expect(rows.map(e => e.payload.text)).toEqual(["hello\n\na\tb", "hello\n\nsecond", "hello\n\nthird"]);
    expect(() => assignments(f.orders, "hello", "rows", "one\n\nthree", new Map())).toThrow("non-empty");
    expect(() => assignments(f.orders, "hello", "rows", "one\ntwo", new Map())).toThrow("exactly");
    const tickets = new Map(f.orders.map(o => [o.orderId, crypto.randomUUID()]));
    expect(assignments(f.orders, "hello", "tickets", "ignored rows", tickets).every(e => e.payload.text === "hello" && e.payload.tickets.length === 1)).toBe(true);
    expect(assignments(f.orders, "hello", "shared", "ignored", tickets).every(e => e.payload.tickets.length === 0)).toBe(true);
    expect(() => assignments(f.orders, "a".repeat(65536), "shared", "", tickets)).toThrow("64 KiB");
  } finally { f.close(); }
});

it.each(["shared", "rows", "tickets"] as const)("delivers 30 orders with %s, splits gas-limited batches, and does not repeat completed uploads or transactions", async mode => {
  const f = await fixture(30); activeService = f.service; f.setLimit(7);
  for (const entry of assignments(f.orders, "Shared content", mode, f.orders.map(o => `Private row ${o.orderId}\tsecret`).join("\n"), new Map(f.orders.map(o => [o.orderId, crypto.randomUUID()])))) f.database.set(entry.order.orderId, entry);
  try {
    await runBulkDelivery(f.runtime, f.op);
    expect(f.op.complete).toBe(true); expect([...f.database.values()].every(e => !e.prepared && !e.payload.text && !e.payload.tickets.length)).toBe(true); expect(f.upload).toHaveBeenCalledTimes(30); expect(f.runtime.prepare).toHaveBeenCalledTimes(30);
    const actions = f.send.mock.calls.map(c => c[1]);
    expect(actions.every(a => "items" in a && a.items.length <= 7)).toBe(true);
    expect(actions.map(a => a.kind)).toEqual(Array.from({ length: actions.length / 2 }, () => ["reserveDeliveries", "publishDeliveries"]).flat());
    const count = f.send.mock.calls.length; await runBulkDelivery(f.runtime, f.op);
    expect(f.send).toHaveBeenCalledTimes(count); expect(f.upload).toHaveBeenCalledTimes(30);
  } finally { f.close(); activeService = undefined; }
}, 30000);

it("recovers after a lost TX1 response using the same encrypted item and then publishes", async () => {
  const f = await fixture(2); activeService = f.service;
  const original = f.runtime.send; let fail = true;
  f.runtime.send = async (...args) => { await original(...args); if (fail) { fail = false; throw new Error("connection lost"); } };
  try {
    await expect(runBulkDelivery(f.runtime, f.op)).rejects.toThrow("connection lost");
    expect(f.op.transactions[0]!.status).toBe("checking");
    const seeds = [...f.database.values()].map(e => e.prepared!.item.seed);
    await runBulkDelivery(f.runtime, f.op);
    expect(f.op.complete).toBe(true); expect(f.send.mock.calls.map(c => c[1].kind)).toEqual(["reserveDeliveries", "publishDeliveries"]);
    expect(f.upload.mock.calls.map(([item]) => item.seed)).toEqual(seeds); expect([...f.database.values()].every(e => !e.prepared && !e.payload.text && !e.payload.tickets.length)).toBe(true); expect(f.runtime.prepare).toHaveBeenCalledTimes(2);
  } finally { f.close(); activeService = undefined; }
});

it("does not reserve an old protected upload whose remaining storage lifetime cannot cover review", async () => {
  const f = await fixture(1); activeService = f.service;
  const entry = f.database.get("1")!;
  entry.prepared = await f.runtime.prepare(entry, f.views.get("1")!); entry.status = "uploaded";
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(entry.prepared.record.expiresAt) - 30000);
  try { const result = await runBulkDelivery(f.runtime, f.op); expect(result[0]!.status).toBe("blocked"); expect(f.send).not.toHaveBeenCalled(); expect(f.op.complete).toBe(false); }
  finally { clock.mockRestore(); activeService = undefined; f.close(); }
});

it("never resubmits a no-hash uncertain transaction; explicit pre-submit failures are retryable", async () => {
  const f = await fixture(1), action: Action = { kind: "reserveDeliveries", items: [{ orderId: "1" }] };
  try {
    f.runtime.send = async () => { throw new Error("network lost"); };
    await expect(sendBatch(f.runtime, f.op, action, tx)).rejects.toThrow();
    await expect(runBulkDelivery(f.runtime, f.op)).rejects.toThrow("uncertain");
    expect(f.op.transactions[0]!.status).toBe("checking");
    f.op.transactions = []; f.runtime.send = async () => { throw new NotSubmitted("not signed"); };
    await expect(sendBatch(f.runtime, f.op, action, tx)).rejects.toThrow(); expect(f.op.transactions[0]!.status).toBe("rejected");
  } finally { f.close(); }
});

it("retries only the identical encrypted signed transaction when broadcast did not arrive", async () => {
  const f = await fixture(1); activeService = f.service;
  const action: Action = { kind: "reserveDeliveries", items: [{ orderId: "1" }] }, raw = "0xsaved-signed-bytes";
  f.op.transactions.push({ action, tx, hash, raw, status: "checking" });
  const original = f.request.getMockImplementation()!; let broadcast = false;
  f.request.mockImplementation(async (path, body) => {
    if (path === "/transactions/batch-status") return { status: broadcast ? "finalized_success" : "uncertain" };
    if (path === "/transactions/broadcast") { expect(body).toEqual({ action, raw }); broadcast = true; f.views.get("1")!.order.publicationDeadline = "200"; f.views.get("1")!.order.state = 9; return {}; }
    return original(path, body);
  });
  try { await runBulkDelivery(f.runtime, f.op); expect(f.runtime.send).not.toHaveBeenCalled(); expect(f.op.transactions[0]!.status).toBe("finalized"); }
  finally { activeService = undefined; f.close(); }
});

it("cancels separately, skips published/disputed/arbitrated orders, isolates failing refunds, and reconciles buyer claims", async () => {
  const f = await fixture(7); f.op.kind = "refund";
  [1, 2, 3, 4, 6, 1, 9].forEach((state, i) => { f.views.get(String(i + 1))!.order.state = state; });
  const original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async (path, body) => { if (path === "/transactions/prepare" && (body as Action).kind === "refundCanceledOrders" && (body as { orderIds: string[] }).orderIds.includes("6")) throw new ApiError("BATCH_SIMULATION_FAILED"); return original(path, body); });
  try {
    await runBulkRefunds(f.runtime, f.op, true); expect(f.send.mock.calls.map(c => c[1].kind)).toEqual(["cancelProduct"]);
    f.views.get("1")!.order.state = 9; // Buyer wins the refund race.
    const entries = await runBulkRefunds(f.runtime, f.op);
    expect(entries.map(e => e.status)).toEqual(["published", "published", "skipped", "skipped", "skipped", "blocked", "published"]);
    expect(f.send.mock.calls[1]![1]).toEqual({ kind: "refundCanceledOrders", orderIds: ["2"] }); expect(f.op.complete).toBe(false);
    f.request.mockImplementation(original); await runBulkRefunds(f.runtime, f.op); expect(f.op.complete).toBe(true);
  } finally { f.close(); }
});

it("built-in delivery authorization is exact, revocable, and does not approve unrelated requests", async () => {
  const seller = Wallet.createRandom(), store = memory(), vault = new WalletVault(store), password = "wallet passphrase for test";
  await vault.import(seller.privateKey, password); const approve = vi.fn(async () => false), session = await unlockWallet(vault, seller.address, password, approve);
  const abi = new Interface(["function reserveDeliveries(uint256[])"]), data = abi.encodeFunctionData("reserveDeliveries", [["1"]]) as `0x${string}`;
  const reviewed = { chainId: 10143 as const, to: deployment.contract as `0x${string}`, data, value: 0n, gas: 100000n, nonce: 0, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n };
  try {
    const scope = { contract: deployment.contract, messages: ["offer context"], commitments: { "1": hash }, references: {} };
    const stop = session.authorizeDelivery(scope);
    await session.signMessage("offer context"); await session.signTransaction(reviewed); expect(approve).not.toHaveBeenCalled();
    await expect(session.signMessage("another action")).rejects.toThrow("declined");
    expect(await deliveryApproval(scope)({ kind: "transaction", transaction: { ...reviewed, data: abi.encodeFunctionData("reserveDeliveries", [["2"]]) as `0x${string}` } })).toBe(false);
    stop(); await expect(session.signMessage("offer context")).rejects.toThrow("declined");
    const origin = "http://localhost:4320", issued = new Date(), expiration = new Date(Date.now() + 300000);
    const message = `${new URL(origin).host} wants you to sign in with your Ethereum account:\n${seller.address}\n\nSign in to PayUnlock. This does not authorize a purchase or payment.\n\nURI: ${origin}\nVersion: 1\nChain ID: 10143\nNonce: abc123\nIssued At: ${issued.toISOString()}\nExpiration Time: ${expiration.toISOString()}\nRequest ID: ${crypto.randomUUID()}`;
    await expect(session.signAppAuthentication(message, origin)).resolves.toMatch(/^0x/);
    await expect(session.signAppAuthentication(message.replace("does not authorize", "authorizes"), origin)).rejects.toThrow("Invalid");
    session.lock(); await expect(session.signMessage("offer context")).rejects.toThrow("locked");
  } finally { session.dispose(); }
}, 15000);

it("retains recovery material until the exact published reference is visible", async () => {
  const f = await fixture(1); activeService = f.service;
  const original = f.runtime.api.request;
  f.runtime.api.request = (async (path: string, body?: unknown) => path.includes('/records') ? { items: [] } : original(path, body)) as typeof original;
  try {
    await expect(runBulkDelivery(f.runtime, f.op)).rejects.toThrow();
    expect(f.database.get('1')!.prepared).toBeDefined();
    expect(f.database.get('1')!.payload.text).toBe('shared secret');
    f.runtime.api.request = original;
    await runBulkDelivery(f.runtime, f.op);
    expect(f.database.get('1')!.prepared).toBeUndefined();
    expect(f.database.get('1')!.payload).toEqual({ text: '', tickets: [] });
  } finally { f.close(); activeService = undefined; }
});

it("reprepares a reserved order after page loss and sends only TX2 with no persisted draft", async () => {
  const f = await fixture(1); activeService = f.service;
  try {
    const deadline = String(Math.floor(Date.now() / 1000) + 600);
    Object.assign(f.views.get('1')!.order, { state: 2, publicationDeadline: deadline });
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (path, body) => path.includes('/history') ? { items: [{ name: 'DeliveryReserved', transactionHash: hash }], nextCursor: null } : original(path, body));
    await runBulkDelivery(f.runtime, f.op);
    expect(f.send.mock.calls.map(c => c[1].kind)).toEqual(['publishDeliveries']);
    expect(f.views.get('1')!.order.publicationDeadline).toBe(deadline);
    const transient = new BulkDeliverySession();
    await transient.create(f.op, f.entries, () => true);
    expect((await transient.entry(f.op.id, '1')).payload.text).toBe('shared secret');
    await expect(new BulkDeliverySession().load(f.op.id)).rejects.toThrow();
    transient.clear(); await expect(transient.load(f.op.id)).rejects.toThrow();
    const prepared = await f.runtime.prepare(f.entries[0]!, f.views.get('1')!);
    const single = new DeliverySession(), id = await single.prepare(prepared, () => true);
    expect((await single.restore(id)).item.seed).toBe(prepared.item.seed);
    await expect(new DeliverySession().restore(id)).rejects.toThrow();
    expect(await single.cleanupConfirmed(id, 'wrong')).toBe(false);
    expect(await single.cleanupConfirmed(id, prepared.recordHash)).toBe(true);
    await expect(single.restore(id)).rejects.toThrow();
  } finally { activeService = undefined; f.close(); }
});
