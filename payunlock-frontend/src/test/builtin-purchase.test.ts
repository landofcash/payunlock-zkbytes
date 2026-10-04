// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Interface, Transaction, ZeroAddress } from "ethers";
import { createManagedSession, type BuiltInSession } from "../wallet/managed-session";
import { prepareBuiltinPurchase, executeBuiltinPurchase, checkBuiltinPurchase, retryBuiltinPurchase } from "../commerce/builtin-purchase";
import type { Asset, Deployment, PreparedTx } from "../commerce/client";
import type { Operation, PurchaseJournal } from "../commerce/purchase-journal";

const escrow = `0x${"22".repeat(20)}`, token = `0x${"44".repeat(20)}`, router = `0x${"55".repeat(20)}`, hash = `0x${"33".repeat(32)}`;
const abi = new Interface(["function approve(address,uint256)", "function purchase(bytes32)"]);
const deployment: Deployment = { chainId: 10143, contract: escrow, router, usdc: token };
let session: BuiltInSession, record: Operation, asset: Asset, submitted: string[], changes: Operation[];
let approvalPrompt = vi.fn(async () => true);
let nextGas: string, nextFee: string, rejectBroadcast: boolean, current: boolean, recovered: boolean, rejectRelay: boolean;
const journal = { save: vi.fn(async (value: Operation) => ({ ...value, version: value.version + 1 })) } as unknown as PurchaseJournal;
function prepared(kind: string): PreparedTx {
  return { chainId: 10143, to: kind === "approve" ? token : escrow, data: kind === "approve" ? abi.encodeFunctionData("approve", [escrow, record.configuration!.terms.price]) : abi.encodeFunctionData("purchase", [record.requestId]), value: record.configuration!.terms.token === ZeroAddress && kind === "purchase" ? record.configuration!.terms.price : "0", nonce: submitted.includes("approve") ? 1 : 0, gas: kind === "purchase" && submitted.includes("approve") ? nextGas : "100000", maxFeePerGas: kind === "purchase" && submitted.includes("approve") ? nextFee : "2", maxPriorityFeePerGas: "1", balance: asset.nativeBalance };
}
const api = {
  read: vi.fn(async (path: string): Promise<any> => path === "/deployment" ? deployment : { status: "pending", transactionHash: null }),
  request: vi.fn(async (path: string, body?: any): Promise<any> => {
    if (path === "/transactions/prepare" || path === "/transactions/request") return prepared(body.kind);
    if (path === "/transactions/broadcast") {
      if (rejectBroadcast) throw new Error("Network unavailable");
      expect(Transaction.from(body.raw).from!.toLowerCase()).toBe(record.account);
      submitted.push(body.action.kind); return { hash: Transaction.from(body.raw).hash };
    }
    if (path.startsWith("/transactions/")) return { status: "finalized_success" };
    if (path.startsWith("/orders/recover/")) return recovered ? { status: "finalized", orderId: "42", order: { buyer: record.account, requestId: record.requestId, buyerReceiving: record.receiving } } : { status: "not_found" };
    if (path === "/relay/payments") { if (rejectRelay) throw new Error("Submission uncertain"); return { id: "relay-job" }; }
    throw new Error(path);
  }),
};
beforeEach(() => {
  vi.clearAllMocks(); submitted = []; changes = []; nextGas = "120000"; nextFee = "2"; rejectBroadcast = false; current = true; recovered = false; rejectRelay = false;
  approvalPrompt = vi.fn(async () => true);
  session = createManagedSession(new Uint8Array([...new Uint8Array(31), 1]), approvalPrompt);
  asset = { token: ZeroAddress, symbol: "MON", decimals: 18, balance: "1000000000", nativeBalance: "1000000000", allowance: "0" };
  record = { id: hash, requestId: hash, account: session.address.toLowerCase(), deployment, receiving: { nonce: hash, publicKey: hash }, hashes: [], version: 1, progress: "draft", configuration: { chainId: 10143, contract: escrow, seller: token, productKey: hash, expectedTerms: hash, terms: { token: ZeroAddress, price: "1000000", hasEventEnd: false, eventEnd: "0", reviewWindow: "86400", commitmentWindow: "600", responseWindow: "600" }, sellerReceiving: { nonce: hash, publicKey: hash }, status: 1, allowed: true, block: { number: 1, hash, timestamp: 1 }, authorizationMode: "direct-only", serviceFee: { bps: 0, treasury: escrow, sellerCapBps: 0 } } };
});
afterEach(() => session.lock());
const execute = async () => executeBuiltinPurchase({ api, journal, session, plan: await prepareBuiltinPurchase(api, record, asset, "Workshop"), current: () => current, onChange: value => { changes.push(value); }, wait: async () => {} });
it("prepares without spending and signs one native purchase without another approval", async () => {
  const plan = await prepareBuiltinPurchase(api, record, asset, "Workshop");
  expect(plan.maxNetworkFee).toBe(200000n); expect(submitted).toEqual([]); expect(approvalPrompt).not.toHaveBeenCalled();
  await execute(); expect(submitted).toEqual(["purchase"]); expect(changes.at(-1)?.progress).toBe("checking"); expect(approvalPrompt).not.toHaveBeenCalled();
  recovered = true;
  expect(await checkBuiltinPurchase(api, journal, changes.at(-1)!)).toMatchObject({ progress: "finalized", orderId: "42" });
  await session.signMessage("unrelated action"); expect(approvalPrompt).toHaveBeenCalledOnce();
});
it("automatically follows exact token approval with payment within the combined fee limit", async () => {
  record.configuration!.terms.token = token; asset.token = token;
  const plan = await prepareBuiltinPurchase(api, record, asset, "Workshop"); expect(plan.maxNetworkFee).toBe(1200000n);
  await execute(); expect(submitted).toEqual(["approve", "purchase"]); expect(approvalPrompt).not.toHaveBeenCalled();
  expect(changes.map(value => value.progress)).toEqual(["checking", "draft", "checking"]);
});
it("skips token approval when the allowance already covers the price", async () => {
  record.configuration!.terms.token = token; asset.token = token; asset.allowance = record.configuration!.terms.price;
  await execute(); expect(submitted).toEqual(["purchase"]);
});
it.each([["600000", "2"], ["120000", "3"]])("stops after approval if payment exceeds reviewed gas or fee bounds (%s, %s)", async (gas, price) => {
  record.configuration!.terms.token = token; asset.token = token;
  const plan = await prepareBuiltinPurchase(api, record, asset, "Workshop"); nextGas = gas; nextFee = price;
  await expect(executeBuiltinPurchase({ api, journal, session, plan, current: () => current, onChange: value => changes.push(value) })).rejects.toThrow("Payment details changed");
  expect(submitted).toEqual(["approve"]); expect(changes.at(-1)?.progress).toBe("draft"); expect(approvalPrompt).not.toHaveBeenCalled();
});
it("retains the signed hash when broadcasting is uncertain and does not initiate another purchase", async () => {
  rejectBroadcast = true;
  await expect(execute()).rejects.toThrow("Network unavailable");
  const saved = changes.at(-1)!; expect(saved.progress).toBe("checking"); expect(saved.activeHash).toMatch(/^0x/);
  expect(await checkBuiltinPurchase(api, journal, saved)).toBe(saved); expect(submitted).toEqual([]);
});
it("stops if the wallet changes after approval and releases the purchase scope", async () => {
  record.configuration!.terms.token = token; asset.token = token;
  const original = api.request.getMockImplementation()!;
  api.request.mockImplementationOnce(original);
  const plan = await prepareBuiltinPurchase(api, record, asset, "Workshop");
  api.request.mockImplementation(async (path, body) => { const value = await original(path, body); if (path.startsWith("/transactions/") && path.includes("?token=")) current = false; return value; });
  try {
    await expect(executeBuiltinPurchase({ api, journal, session, plan, current: () => current, onChange: value => changes.push(value) })).rejects.toThrow("Wallet locked or changed");
    expect(submitted).toEqual(["approve"]);
  } finally { api.request.mockImplementation(original); }
  await session.signMessage("ordinary request"); expect(approvalPrompt).toHaveBeenCalledOnce();
});
it("sponsored checkout signs only its exact authorization and saves uncertain submission", async () => {
  record.configuration!.terms.token = token; record.configuration!.authorizationMode = "eip3009-receive";
  asset = { ...asset, token, symbol: "USDC", decimals: 6, authorizationProfile: { mode: "eip3009-receive", name: "USDC", version: "2" } };
  rejectRelay = true;
  await expect(execute()).rejects.toThrow("Submission uncertain");
  expect(changes.at(-1)).toMatchObject({ progress: "checking", relayNonce: expect.any(String), relayJobId: undefined });
  expect(approvalPrompt).not.toHaveBeenCalled(); expect(submitted).toEqual([]);
});
it("never signs when there is insufficient MON for both token transactions", async () => {
  record.configuration!.terms.token = token; asset.token = token; asset.nativeBalance = "300000";
  await expect(execute()).rejects.toThrow("maximum network fees"); expect(submitted).toEqual([]); expect(approvalPrompt).not.toHaveBeenCalled();
});
it("places a sponsored purchase without another wallet prompt", async () => {
  record.configuration!.terms.token = token; record.configuration!.authorizationMode = "eip3009-receive";
  asset = { ...asset, token, symbol: "USDC", decimals: 6, authorizationProfile: { mode: "eip3009-receive", name: "USDC", version: "2" } };
  await execute();
  expect(changes.at(-1)).toMatchObject({ progress: "checking", relayJobId: "relay-job" });
  expect(api.request.mock.calls.filter(([path]) => path === "/relay/payments")).toHaveLength(1);
  expect(approvalPrompt).not.toHaveBeenCalled(); expect(submitted).toEqual([]);
});
it.each(["checking", "finalized"] as const)("refuses to prepare a checkout that is already %s", async progress => {
  record.progress = progress;
  await expect(execute()).rejects.toThrow("Check the current payment status"); expect(approvalPrompt).not.toHaveBeenCalled(); expect(submitted).toEqual([]);
});
it("resubmits after a relay submission failure without changing the checkout or receiving identity", async () => {
  record.configuration!.terms.token = token; record.configuration!.authorizationMode = "eip3009-receive";
  asset = { ...asset, token, symbol: "USDC", decimals: 6, authorizationProfile: { mode: "eip3009-receive", name: "USDC", version: "2" } };
  rejectRelay = true;
  await expect(execute()).rejects.toThrow("Submission uncertain");
  const pending = changes.at(-1)!;
  record = await retryBuiltinPurchase(api, journal, pending);
  expect(record).toMatchObject({ id: pending.id, requestId: pending.requestId, receiving: pending.receiving, account: pending.account, progress: "draft", relayNonce: undefined });
  rejectRelay = false;
  await execute();
  const packets = api.request.mock.calls.filter(([path]) => path === "/relay/payments").map(([, body]) => body);
  expect(packets).toHaveLength(2); expect(packets[1].intent).toEqual(packets[0].intent);
  expect(changes.at(-1)).toMatchObject({ progress: "checking", relayJobId: "relay-job" });
  expect(approvalPrompt).not.toHaveBeenCalled();
});
it("recovers an already completed order instead of resetting it for retry", async () => {
  const pending = { ...record, progress: "checking" as const, relayNonce: hash };
  recovered = true;
  expect(await retryBuiltinPurchase(api, journal, pending)).toMatchObject({ progress: "finalized", orderId: "42", requestId: record.requestId });
  expect(api.request.mock.calls.some(([path]) => path === "/relay/payments")).toBe(false);
});
it.each([{ relayJobId: "job" }, { activeHash: hash }, { action: { kind: "purchase" as const, requestId: hash, expectedTerms: hash } }])("does not reset an accepted or direct payment for sponsored retry (%#)", async extra => {
  await expect(retryBuiltinPurchase(api, journal, { ...record, progress: "checking", relayNonce: hash, ...extra })).rejects.toThrow("Check the current payment status");
  expect(journal.save).not.toHaveBeenCalled();
});
