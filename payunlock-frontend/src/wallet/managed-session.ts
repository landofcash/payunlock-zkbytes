import { createSecp256k1SigningSession } from "@category-labs/mera";
import { toViemAccount } from "@category-labs/mera/viem";
import { getBytes } from "ethers";
import type { WalletVault } from "./vault";
import type { WalletSessionEvent } from "./types";

export const SESSION_LIFETIME_MS = 5 * 60 * 1000;
export type ReviewedTransaction = Readonly<{
  chainId: 10143; to: `0x${string}`; data: `0x${string}`; value: bigint;
  nonce: number; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint;
}>;
export type Approval = (request: Readonly<{ kind: "message"; message: string } | { kind: "transaction"; transaction: ReviewedTransaction }>) => Promise<boolean>;

export async function unlockWallet(vault: WalletVault, address: string, password: string, approve: Approval, lifetime = SESSION_LIFETIME_MS) {
  const secret = await vault.export(address, password);
  const key = getBytes(secret.privateKey);
  secret.privateKey = ""; secret.mnemonic = null;
  const signer = (() => { try { return createSecp256k1SigningSession({ privateKey: key }); } finally { key.fill(0); } })();
  const account = toViemAccount(signer);
  const expiresAt = Date.now() + Math.min(Math.max(lifetime, 1), SESSION_LIFETIME_MS);
  let ended = false, busy = false;
  const listeners = new Set<(event: WalletSessionEvent) => void>();
  const timer = setTimeout(lock, expiresAt - Date.now());
  function lock() {
    if (ended) return;
    ended = true; clearTimeout(timer); signer.end();
    for (const listener of listeners) listener("disconnect");
    listeners.clear();
  }
  function check() { if (Date.now() >= expiresAt) lock(); if (ended) throw new Error("Wallet is locked."); }
  async function reviewed<T>(request: Parameters<Approval>[0], sign: () => Promise<T>) {
    check(); if (busy) throw new Error("A wallet request is already pending."); busy = true;
    try { if (!await approve(request)) throw new Error("Signing declined."); check(); const result = await sign(); check(); return result; }
    finally { busy = false; }
  }
  return {
    kind: "builtin" as const, walletName: "Built-in wallet", transport: "managed" as const,
    address: account.address, chainId: "0x279f", expiresAt,
    get locked() { if (Date.now() >= expiresAt) lock(); return ended; },
    signMessage: (message: string) => reviewed({ kind: "message", message }, () => account.signMessage({ message })),
    signTransaction(transaction: ReviewedTransaction) {
      // Clone before showing review so callers cannot change the approved payload.
      const snapshot = Object.freeze({ ...transaction });
      if (snapshot.chainId !== 10143 || snapshot.value < 0n || snapshot.gas <= 0n || !Number.isSafeInteger(snapshot.nonce) || snapshot.nonce < 0 || snapshot.maxPriorityFeePerGas < 0n || snapshot.maxFeePerGas < snapshot.maxPriorityFeePerGas) throw new Error("Invalid transaction.");
      return reviewed({ kind: "transaction", transaction: snapshot }, () => account.signTransaction({ ...snapshot, type: "eip1559" }));
    },
    lock, dispose: lock, disconnect: async () => lock(),
    subscribe(listener: (event: WalletSessionEvent) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
export type BuiltInSession = Awaited<ReturnType<typeof unlockWallet>>;
