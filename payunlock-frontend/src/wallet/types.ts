import type {ReviewedTransaction} from "./managed-session";
import type {DeliveryAuthorization} from "./delivery-authorization";
import type {PurchaseAuthorization} from "./purchase-authorization";
import type {SellerAuthorization} from "./seller-authorization";

export type WalletKind = "metamask" | "walletconnect" | "fixture" | "builtin";
export type WalletSessionEvent =
  "accountsChanged" | "chainChanged" | "disconnect";
export type ReviewedTypedData = Readonly<{
  domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` };
  primaryType: string;
  types: Record<string, { name: string; type: string }[]>;
  message: Record<string, string>;
  review: {
    title: string;
    asset: string;
    amount: string;
    rawValue: string;
    decimals: number;
    recipient: string;
    expiresAt: string
  };
}>;

export interface LabWalletSession {
  kind: WalletKind;
  walletName: string;
  transport: "extension" | "deeplink" | "qr" | "fixture" | "managed";
  address: string;
  passkey?: Readonly<{ credentialId: string; rpId: string }>;
  chainId?: string;
  readonly locked?: boolean;

  signMessage(message: string): Promise<string | Uint8Array>;

  signTypedData?(request: ReviewedTypedData): Promise<string>;

  signAppAuthentication?(message: string, origin: string): Promise<string>;

  signReceivingIdentity?(message: string): Promise<string>;

  authorizeDelivery?(scope: DeliveryAuthorization): () => void;

  authorizePurchase?(scope: PurchaseAuthorization): () => void;

  authorizeSeller?(scope: SellerAuthorization): () => void;

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
