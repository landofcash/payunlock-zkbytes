// @vitest-environment node
import { expect, it, vi } from "vitest";
import { sendReviewedTransaction } from "../wallet/transactions";
const address = `0x${"11".repeat(20)}` as const;
const hash = `0x${"22".repeat(32)}`;
const transaction = { chainId: 10143 as const, to: address, data: "0x" as const, value: 1n, nonce: 0, gas: 21000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n };
it.each([10143, "10143", "0x279f", "0x279F"])("accepts the Monad chain ID representation %s", async chain => {
  const request = vi.fn(async ({ method }: { method: string }) => method === "eth_chainId" ? chain : hash);
  await expect(sendReviewedTransaction(request, transaction, address, async () => {})).resolves.toBe(hash);
});
it.each([1, "0x1", 143, "143", "0x8f", null, undefined, true, {}, "eip155:10143", "10143junk", "1.0143e4", 10143.5])("never submits on a wrong or malformed chain ID %j", async chain => {
  const request = vi.fn(async ({ method }: { method: string }) => method === "eth_chainId" ? chain : hash);
  await expect(sendReviewedTransaction(request, transaction, address, async () => {})).rejects.toThrow("Switch to Monad Testnet");
  expect(request.mock.calls.some(([args]) => args.method === "eth_sendTransaction")).toBe(false);
});
