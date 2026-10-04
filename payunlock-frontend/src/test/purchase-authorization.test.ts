// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createManagedSession, type BuiltInSession, type ReviewedTransaction } from "../wallet/managed-session";
import type { PurchaseAuthorization } from "../wallet/purchase-authorization";
const tx: ReviewedTransaction = { chainId: 10143, to: `0x${"22".repeat(20)}`, data: "0x1234", value: 10n, nonce: 0, gas: 21000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n };
let session: BuiltInSession;
const prompt = vi.fn(async () => true);
const scope = (): PurchaseAuthorization => ({ transactions: [{ transaction: tx, maxNetworkFee: 42000n }] });
beforeEach(() => { prompt.mockClear(); session = createManagedSession(new Uint8Array([...new Uint8Array(31), 1]), prompt); });
afterEach(() => { session.lock(); vi.useRealTimers(); });
it.each([
  { value: 11n }, { to: `0x${"33".repeat(20)}` }, { data: "0xabcd" }, { nonce: 1 }, { gas: 21001n }, { maxFeePerGas: 3n },
])("rejects a changed purchase request without opening a second approval (case %#)", async change => {
  session.authorizePurchase(scope());
  await expect(session.signTransaction({ ...tx, ...change } as ReviewedTransaction)).rejects.toThrow("Payment details changed");
  expect(prompt).not.toHaveBeenCalled();
});
it("consumes reviewed transactions once and releases the scope explicitly", async () => {
  const release = session.authorizePurchase(scope());
  await session.signTransaction(tx);
  await expect(session.signTransaction(tx)).rejects.toThrow("Payment details changed");
  await expect(session.signMessage("unrelated payment")).rejects.toThrow("Payment details changed");
  expect(prompt).not.toHaveBeenCalled(); release();
  await session.signTransaction(tx); expect(prompt).toHaveBeenCalledOnce();
});
it("snapshots approved payloads so caller mutation cannot expand approval", async () => {
  const approved = scope(); session.authorizePurchase(approved);
  approved.transactions[0]!.transaction = { ...tx, value: 100n };
  await expect(session.signTransaction(approved.transactions[0]!.transaction)).rejects.toThrow("Payment details changed");
  await session.signTransaction(tx); expect(prompt).not.toHaveBeenCalled();
});
it("applies the total fee bound even when gas and fee per gas are individually allowed", async () => {
  session.authorizePurchase({ transactions: [{ transaction: tx, maxNetworkFee: 100n }] });
  await expect(session.signTransaction(tx)).rejects.toThrow("Payment details changed"); expect(prompt).not.toHaveBeenCalled();
});
it("cannot reuse the authorization after the wallet session expires", async () => {
  session.lock(); vi.useFakeTimers();
  session = createManagedSession(new Uint8Array([...new Uint8Array(31), 1]), prompt, 100);
  session.authorizePurchase(scope()); vi.advanceTimersByTime(101);
  await expect(session.signTransaction(tx)).rejects.toThrow("locked"); expect(prompt).not.toHaveBeenCalled();
});
