import type { ReviewedTransaction } from "./managed-session";
export type WalletKind = "metamask" | "walletconnect" | "fixture" | "builtin";
export type WalletSessionEvent =
  "accountsChanged" | "chainChanged" | "disconnect";
export interface LabWalletSession {
  kind: WalletKind;
  walletName: string;
  transport: "extension" | "deeplink" | "qr" | "fixture" | "managed";
  address: string;
  chainId?: string;
  signMessage(message: string): Promise<string | Uint8Array>;
  readonly locked?: boolean;
  signTransaction?(transaction: ReviewedTransaction): Promise<string>;
  sendTransaction?(transaction: ReviewedTransaction): Promise<string>;
  disconnect(): Promise<void>;
  switchNetwork?(): Promise<void>;
  subscribe?(listener: (event: WalletSessionEvent) => void): () => void;
  dispose?(): void;
}
export interface LabWalletAdapter {
  kind: WalletKind;
  label: string;
  connect(): Promise<LabWalletSession>;
}
