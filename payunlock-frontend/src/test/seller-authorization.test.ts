// @vitest-environment node
import { expect, it, vi } from "vitest";
import { getBytes, keccak256, Transaction } from "ethers";
import { createManagedSession, type ReviewedTransaction } from "@/wallet/managed-session";
import { DELIVERY_GAS_BOUND, sellerDeliveryAbi, type SellerAuthorization } from "@/wallet/seller-authorization";
import type { ReviewedTypedData } from "@/wallet/types";

const contract = `0x${"22".repeat(20)}`, router = `0x${"33".repeat(20)}`;
const reference = { serviceId: 1, preparedAt: "100", creator: `0x${"11".repeat(32)}`, buyerEnvelope: `0x03${"11".repeat(64)}`, sellerEnvelope: `0x03${"22".repeat(64)}`, contentHash: `0x${"44".repeat(32)}` };
const calls = [sellerDeliveryAbi.encodeFunctionData("reserveDelivery", [7]), sellerDeliveryAbi.encodeFunctionData("publishDelivery", [7, reference])];
const transaction = (data: string, nonce: number): ReviewedTransaction => ({ chainId: 10143, to: contract as `0x${string}`, data: data as `0x${string}`, value: 0n, nonce, gas: 600_000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n });
function typed(account: string, data: string): ReviewedTypedData {
  const validBefore = String(Math.floor(Date.now() / 1000) + 3600);
  return { domain: { name: "PayUnlockActionRouter", version: "1", chainId: 10143, verifyingContract: router as `0x${string}` }, primaryType: "PayUnlockAction", types: { PayUnlockAction: [{ name: "actor", type: "address" }, { name: "escrow", type: "address" }, { name: "actionHash", type: "bytes32" }, { name: "nonce", type: "bytes32" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }] }, message: { actor: account, escrow: contract, actionHash: keccak256(data), nonce: `0x${"55".repeat(32)}`, validAfter: "0", validBefore }, review: { title: "Delivery", asset: "token", amount: "0", rawValue: "0", decimals: 0, recipient: contract, expiresAt: new Date(Number(validBefore) * 1000).toISOString() } };
}
it.each(["sponsored", "self"] as const)("signs the reviewed delivery once using %s fees, without another approval", async kind => {
  const prompt = vi.fn(async () => false), session = createManagedSession(getBytes(`0x${"12".repeat(32)}`), prompt);
  const scope: SellerAuthorization = { account: session.address, contract, calls, payment: kind === "self" ? { kind, nonce: 3, gas: DELIVERY_GAS_BOUND, maxFeePerGas: 10n } : { kind, router } };
  const release = session.authorizeSeller(scope);
  try {
    if (kind === "self") {
      expect(Transaction.from(await session.signTransaction(transaction(calls[0]!, 3))).data).toBe(calls[0]);
      await expect(session.signTransaction({ ...transaction(calls[1]!, 4), gas: DELIVERY_GAS_BOUND + 1n })).rejects.toThrow("details or fees changed");
      await expect(session.signTransaction({ ...transaction(calls[1]!, 4), maxFeePerGas: 11n })).rejects.toThrow("details or fees changed");
      await expect(session.signTypedData(typed(session.address, calls[1]!))).rejects.toThrow("details or fees changed");
      await expect(session.signTransaction(transaction(calls[1]!, 5))).rejects.toThrow("details or fees changed");
      await session.signTransaction(transaction(calls[1]!, 4));
      await expect(session.signTransaction(transaction(calls[1]!, 4))).rejects.toThrow("details or fees changed");
    } else {
      await session.signTypedData(typed(session.address, calls[0]!));
      const altered = sellerDeliveryAbi.encodeFunctionData("publishDelivery", [8, reference]);
      await expect(session.signTypedData(typed(session.address, altered))).rejects.toThrow("details or fees changed");
      const alteredContent = sellerDeliveryAbi.encodeFunctionData("publishDelivery", [7, { ...reference, contentHash: reference.creator }]);
      await expect(session.signTypedData(typed(session.address, alteredContent))).rejects.toThrow("details or fees changed");
      await expect(session.signTransaction(transaction(calls[1]!, 4))).rejects.toThrow("details or fees changed");
      await session.signTypedData(typed(session.address, calls[1]!));
      await expect(session.signTypedData(typed(session.address, calls[1]!))).rejects.toThrow("details or fees changed");
    }
    expect(prompt).not.toHaveBeenCalled();
    release();
    await expect(session.signMessage("unrelated")).rejects.toThrow("declined");
    expect(prompt).toHaveBeenCalledOnce();
  } finally { release(); session.lock(); }
});
it("clears seller approval when the wallet locks", async () => {
  const prompt = vi.fn(async () => false), session = createManagedSession(getBytes(`0x${"12".repeat(32)}`), prompt);
  session.authorizeSeller({ account: session.address, contract, calls, payment: { kind: "sponsored", router } });
  session.lock();
  await expect(session.signTypedData(typed(session.address, calls[0]!))).rejects.toThrow("locked");
  expect(prompt).not.toHaveBeenCalled();
});
