import { createSecp256k1SigningSession } from "@category-labs/mera";
import { toViemAccount } from "@category-labs/mera/viem";
import { getAddress, getBytes } from "ethers";
import type { WalletVault } from "./vault";
import type { ReviewedTypedData, WalletSessionEvent } from "./types";
import { validateTokenAuthorization } from "./typed-data";
import { deliveryApproval, type DeliveryAuthorization } from "./delivery-authorization";
import { purchaseApproval, type PurchaseAuthorization } from "./purchase-authorization";
import { receivingMessage, ReceivingContextSchema } from "@/commerce/protocol";

export const SESSION_LIFETIME_MS = 5 * 60 * 1000;
export type ReviewedTransaction = Readonly<{
  chainId: 10143; to: `0x${string}`; data: `0x${string}`; value: bigint;
  nonce: number; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint;
}>;
export type Approval = (request: Readonly<{ kind: "message"; message: string } | { kind: "transaction"; transaction: ReviewedTransaction } | { kind: "typedData"; typedData: ReviewedTypedData }>) => Promise<boolean>;

export async function unlockWallet(vault: WalletVault, address: string, password: string, approve: Approval, lifetime = SESSION_LIFETIME_MS) {
  const secret = await vault.export(address, password);
  const key = getBytes(secret.privateKey);
  secret.privateKey = ""; secret.mnemonic = null;
  return createManagedSession(key, approve, lifetime);
}

// Consumes the supplied key; Mera owns the only retained byte-array copy.
export function createManagedSession(key: Uint8Array, approve: Approval, lifetime = SESSION_LIFETIME_MS) {
  const signer = (() => { try { return createSecp256k1SigningSession({ privateKey: key }); } finally { key.fill(0); } })();
  const account = toViemAccount(signer);
  const expiresAt = Date.now() + Math.min(Math.max(lifetime, 1), SESSION_LIFETIME_MS);
  let ended = false, busy = false;
  let delivery: Approval | undefined;
  let purchase: Approval | undefined;
  const listeners = new Set<(event: WalletSessionEvent) => void>();
  const timer = setTimeout(lock, expiresAt - Date.now());
  function lock() {
    if (ended) return;
    ended = true; delivery = undefined; purchase = undefined; clearTimeout(timer); signer.end();
    for (const listener of listeners) listener("disconnect");
    listeners.clear();
  }
  function check() { if (Date.now() >= expiresAt) lock(); if (ended) throw new Error("Wallet is locked."); }
  async function reviewed<T>(request: Parameters<Approval>[0], sign: () => Promise<T>) {
    check(); if (busy) throw new Error("A wallet request is already pending."); busy = true;
    try { if (!(purchase ? await purchase(request) : delivery && await delivery(request)) && !await approve(request)) throw new Error("Signing declined."); check(); const result = await sign(); check(); return result; }
    finally { busy = false; }
  }
  return {
    kind: "builtin" as const, walletName: "Built-in wallet", transport: "managed" as const,
    address: account.address, chainId: "0x279f", expiresAt,
    authorizeDelivery(scope: DeliveryAuthorization) { check(); const approval = deliveryApproval(scope); delivery = approval; return () => { if (delivery === approval) delivery = undefined; }; },
    authorizePurchase(scope: PurchaseAuthorization) { check(); if (purchase || busy) throw new Error("A wallet request is already pending."); const approval = purchaseApproval(scope); purchase = approval; return () => { if (purchase === approval) purchase = undefined; }; },
    get locked() { if (Date.now() >= expiresAt) lock(); return ended; },
    signMessage: (message: string) => reviewed({ kind: "message", message }, () => account.signMessage({ message })),
    signTypedData(request: ReviewedTypedData) {
      const snapshot = validateTokenAuthorization(request, account.address);
      return reviewed({ kind: "typedData", typedData: snapshot }, () => account.signTypedData({ domain: snapshot.domain, types: snapshot.types, primaryType: snapshot.primaryType, message: snapshot.message }));
    },
    async signReceivingIdentity(message: string) {
      check();
      const lines = message.split("\n");
      const context = ReceivingContextSchema.parse(JSON.parse(lines[1] ?? "null"));
      if (context.account !== account.address.toLowerCase() || message !== receivingMessage(context)) throw new Error("Invalid encryption-key request.");
      if (busy) throw new Error("A wallet request is already pending.");
      busy = true;
      try { const signature = await account.signMessage({ message }); check(); return signature; } finally { busy = false; }
    },
    async signAppAuthentication(message: string, origin: string) {
      check();
      const lines = message.split("\n"), now = Date.now();
      if (lines.length !== 12 || lines[0] !== `${new URL(origin).host} wants you to sign in with your Ethereum account:` || lines[1] !== getAddress(account.address) || lines[2] !== "" || lines[3] !== "Sign in to PayUnlock. This does not authorize a purchase or payment." || lines[4] !== "" || lines[5] !== `URI: ${origin}` || lines[6] !== "Version: 1" || lines[7] !== "Chain ID: 10143" || !/^Nonce: [a-zA-Z0-9]+$/.test(lines[8]!) || !lines[9]?.startsWith("Issued At: ") || !lines[10]?.startsWith("Expiration Time: ") || !/^Request ID: [a-zA-Z0-9-]+$/.test(lines[11]!) || !(Date.parse(lines[9]!.slice(11)) <= now + 30000 && Date.parse(lines[10]!.slice(17)) > now && Date.parse(lines[10]!.slice(17)) <= now + 600000)) throw new Error("Invalid application sign-in request.");
      if (busy) throw new Error("A wallet request is already pending.");
      busy = true;
      try { const signature = await account.signMessage({ message }); check(); return signature; } finally { busy = false; }
    },
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
