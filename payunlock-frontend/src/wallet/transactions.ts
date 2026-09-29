import { toQuantity } from "ethers";
import type { ReviewedTransaction } from "./managed-session";
export async function sendReviewedTransaction(request: (args: { method: string; params?: unknown[] }) => Promise<unknown>, tx: ReviewedTransaction, from: string, check: () => Promise<void>) {
  const snapshot = Object.freeze({ ...tx });
  if (snapshot.chainId !== 10143 || snapshot.value < 0n || snapshot.gas <= 0n || snapshot.maxFeePerGas < snapshot.maxPriorityFeePerGas) throw new Error("Invalid transaction.");
  await check();
  const chainId = await request({ method: "eth_chainId" });
  // WalletConnect UniversalProvider returns a number; injected providers usually return hex.
  const validChainId = typeof chainId === "number"
    ? Number.isSafeInteger(chainId) && chainId > 0
    : typeof chainId === "string" && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(chainId);
  if (!validChainId || BigInt(chainId as string | number) !== BigInt(snapshot.chainId)) throw new Error("Switch to Monad Testnet.");
  await check();
  const hash = await request({ method: "eth_sendTransaction", params: [{ from, to: snapshot.to, data: snapshot.data, chainId: "0x279f", value: toQuantity(snapshot.value), nonce: toQuantity(snapshot.nonce), gas: toQuantity(snapshot.gas), maxFeePerGas: toQuantity(snapshot.maxFeePerGas), maxPriorityFeePerGas: toQuantity(snapshot.maxPriorityFeePerGas), type: "0x2" }] });
  // After this point any error is uncertain: callers must preserve their request ID.
  await check();
  if (typeof hash !== "string" || !/^0x[\da-f]{64}$/i.test(hash)) throw new Error("Transaction outcome uncertain. Recover the original request.");
  return hash;
}
