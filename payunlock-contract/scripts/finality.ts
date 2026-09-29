export interface Receipt { blockNumber: number; blockHash: string; status: number | null; hash: string; }
export interface FinalityProvider {
  getTransactionReceipt(hash: string): Promise<Receipt | null>;
  getBlock(tag: string | number): Promise<{ number: number; hash: string | null } | null>;
}
// A receipt and elapsed time alone are never finality. Check the canonical block
// twice around the receipt read so disappearing/replaced receipts stay uncertain.
export async function finalizedReceipt(provider: FinalityProvider, hash: string) {
  const receipt = await provider.getTransactionReceipt(hash);
  if (!receipt || receipt.status === null) return null;
  const finalized = await provider.getBlock("finalized");
  if (!finalized?.hash || finalized.number < receipt.blockNumber) return null;
  const canonical = await provider.getBlock(receipt.blockNumber);
  if (canonical?.hash !== receipt.blockHash) return null;
  const repeated = await provider.getTransactionReceipt(hash);
  if (!repeated || repeated.blockHash !== receipt.blockHash || repeated.blockNumber !== receipt.blockNumber || repeated.status !== receipt.status) return null;
  const latestCanonical = await provider.getBlock(receipt.blockNumber);
  return latestCanonical?.hash === receipt.blockHash ? repeated : null;
}

export async function waitFinalized(provider: FinalityProvider, hash: string, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await finalizedReceipt(provider, hash);
    if (receipt) return receipt;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error("Transaction is still uncertain; resume the saved transaction hash.");
}
