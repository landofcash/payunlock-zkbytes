export type WalletErrorKind =
  | "rejected"
  | "pending"
  | "wrong-account"
  | "unsupported"
  | "disconnected"
  | "provider"
  | "network"
  | "configuration"
  | "cancelled";

export class WalletError extends Error {
  constructor(public readonly kind: WalletErrorKind) {
    super(kind);
  }
}

export function walletErrorKind(error: unknown): WalletErrorKind {
  if (error instanceof WalletError) return error.kind;
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : undefined;
  if (code === 4001 || code === "4001") return "rejected";
  if (code === -32002 || code === "-32002") return "pending";
  if (code === 4200 || code === -32601 || code === "4200" || code === "-32601")
    return "unsupported";
  if (code === 4900 || code === 4901 || code === "4900" || code === "4901")
    return "disconnected";
  return "provider";
}

export const walletErrorMessages: Record<WalletErrorKind, string> = {
  configuration:
    "WalletConnect needs a valid Reown project ID. Configure it and restart the app.",
  cancelled: "Wallet connection cancelled. You can connect again when ready.",
  network: "Open Manage wallet, switch to Monad Testnet, then try again.",
  rejected: "Request declined in the wallet. You can try again when ready.",
  pending:
    "A wallet request is already open. Finish or dismiss it in your wallet, then try again.",
  "wrong-account":
    "The signing account changed or the signature belongs to another account. Check the selected account and try again.",
  unsupported:
    "This wallet did not return a supported canonical EOA signature. Smart accounts and noncanonical signatures are not supported in this version.",
  disconnected: "The wallet disconnected. Connect again to continue.",
  provider:
    "The wallet request could not be completed. Check your wallet and try again.",
};
