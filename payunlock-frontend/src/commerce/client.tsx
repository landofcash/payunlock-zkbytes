import {ArrowRight as ButtonArrowRight, Wallet as ButtonWallet} from "lucide-react";
import {Button} from "@/components/ui/button";
import {createContext, type ReactNode, useContext, useEffect, useRef, useState} from "react";
import {UnlockDialog} from "@/wallet/UnlockDialog";
import {forgetLastUsedAccount} from "@/wallet/last-used";
import {hexlify} from "ethers";
import {useSession} from "@/wallet/session-store";
import type {ChainAssignment, LifecycleAction} from "./lifecycle";

export type Receiving = { nonce: string; publicKey: string };
export type Terms = {
  token: string;
  price: string;
  hasEventEnd: boolean;
  eventEnd: string;
  reviewWindow: string;
  responseWindow: string;
  commitmentWindow: string
};
export type Configuration = {
  chainId: 10143;
  contract: string;
  seller: string;
  productKey: string;
  expectedTerms: string;
  terms: Terms;
  sellerReceiving: Receiving;
  status: number;
  allowed: boolean;
  block: { number: number; hash: string; timestamp: number };
  authorizationMode: "eip3009-receive" | "direct-only";
  serviceFee: { bps: number; treasury: string; sellerCapBps: number }
};
export type Deployment = { chainId: 10143; contract: string; router: string; usdc: string };
export type DraftTerms = {
  token: string;
  price: string;
  eventEnd: string | null;
  reviewWindow: string | null;
  commitmentWindow: number
};
export type RegistrationConfiguration = Configuration & {
  productTerms?: {
    token: string;
    price: string;
    hasEventEnd: boolean;
    eventEnd: string;
    hasReviewOverride: boolean;
    reviewOverride: string;
    commitmentWindow: string
  }
};
export type OfferImage = { id: string; url: string; thumbnailUrl: string; width: number; height: number };
export type Product = {
  id: string;
  title: string;
  description: string;
  images?: OfferImage[];
  restricted?: boolean;
  frontpagePosition?: number | null;
  revision: number;
  seller?: string;
  visibility?: "draft" | "public" | "hidden";
  draftTerms?: DraftTerms;
  sale?: { status: string; productState?: number; terms?: Pick<DraftTerms, "token" | "price"> }
};
export type OrderView = {
  orderId: string;
  block: Configuration["block"];
  order: {
    state: number;
    buyer: string;
    seller: string;
    requestId: string;
    productKey: string;
    terms: Terms;
    buyerReceiving: Receiving;
    sellerReceiving: Receiving;
    deliveryHash: string;
    publicationDeadline: string;
    reviewDeadline: string;
    responseDeadline: string;
    turn: string
  };
  assignment?: ChainAssignment;
  canceled: boolean;
  eligibility: Record<string, boolean>;
  offer: { status: string; title?: string; description?: string; images?: OfferImage[] };
  indexing?: { status?: string }
};
export type PublicOrder = Pick<OrderView, "orderId" | "block" | "canceled"> & {
  arbitrator?: string;
  order: Pick<OrderView["order"], "state" | "buyer" | "seller" | "terms" | "publicationDeadline" | "reviewDeadline" | "responseDeadline">;
  offer: { id: string; title: string; description: string; images?: OfferImage[] } | null
};
export type Action = LifecycleAction | {
  kind: "create";
  productId: string;
  receiving: Receiving;
  feeCapBps: number;
  expectedPlacementFee: string;
  expectedFeeVersion: string
} | { kind: "update"; productId: string; receiving: Receiving } | {
  kind: "disable";
  productId: string;
  disabled: boolean
} | { kind: "purchase" | "approve"; requestId: string; expectedTerms: string } | {
  kind: "approveArbitrationFee";
  orderId: string;
  arbitrator: string;
  expectedFee: string;
  expectedFeeAsset: string
} | { kind: "claimRefund" | "claimResponseTimeout" | "withdrawSeller"; orderId: string };
export type PreparedTx = {
  chainId: 10143;
  to: string;
  data: string;
  value: string;
  gas: string;
  nonce: number;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  balance: string
};
export type Asset = {
  token: string;
  symbol: string;
  decimals: number;
  balance: string;
  nativeBalance: string;
  allowance: string;
  authorizationProfile?: { mode: "eip3009-receive"; name: string; version: string }
};
export type Page<T> = { items: T[]; nextCursor: string | null; indexing?: { status?: string } };

export class ApiError extends Error {
  constructor(public code: string) {
    super(code === "FEATURED_LIST_CHANGED" ? "Featured offers changed in another session. Reload the list or admin status before saving again." : code.toLowerCase().replaceAll("_", " "));
  }
}

export async function apiRequest<T>(origin: string, path: string, token?: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
  const response = await fetch(`${origin}/v1${path}`, {
    method,
    headers: {...(body === undefined ? {} : {"content-type": body instanceof Blob ? "application/octet-stream" : "application/json"}), ...(token ? {authorization: `Bearer ${token}`} : {})}, ...(body === undefined ? {} : {body: body instanceof Blob ? body : JSON.stringify(body)}),
    signal: AbortSignal.timeout(body instanceof Blob ? 120000 : 20000)
  });
  const value = await response.json();
  if (!response.ok) throw new ApiError(typeof value.error === "string" ? value.error : "SERVICE_UNAVAILABLE");
  return value as T;
}

export const MediaOriginContext = createContext("");
type Client = {
  read<T>(path: string): Promise<T>;
  request<T>(path: string, body?: unknown, method?: string): Promise<T>
};
const Context = createContext<Client | null>(null);
const AccessContext = createContext<{
  address: string | null;
  authenticated: boolean;
  busy: boolean;
  error: string;
  authorize(expectedAddress?: string): void;
  unlock(expectedAddress?: string): void;
  signOut(): Promise<void>
} | null>(null);

export function CommerceProvider({origin, children}: { origin: string; children: ReactNode }) {
  const wallet = useSession(), token = useRef<{ key: string; value: string; expires: number } | null>(null);
  const [grant, setGrant] = useState<{ key: string; expires: number } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [pendingAuthorization, setPendingAuthorization] = useState(false), [signing, setSigning] = useState(false);
  const [unlockOpen, setUnlockOpen] = useState(false), [expectedAddress, setExpectedAddress] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null),
    authentication = useRef<{ key: string; promise: Promise<void> } | null>(null);
  const key = `${wallet.sessionEpoch}:${wallet.identityEpoch}:${wallet.session?.address ?? ""}`;
  const current = useRef(key);
  current.current = key;

  function revokeToken() {
    const previous = token.current;
    token.current = null;
    setGrant(null);
    if (previous) void apiRequest(origin, "/auth/logout", previous.value, undefined, "POST").catch(() => {
    });
  }

  useEffect(() => {
    if (token.current?.key !== key) revokeToken();
  }, [key]);
  useEffect(() => {
    if (!grant || grant.key !== key) return;
    const timer = setTimeout(revokeToken, Math.max(0, grant.expires - Date.now()));
    return () => clearTimeout(timer);
  }, [grant, key]);
  useEffect(() => {
    if (signing) dialog.current?.showModal(); else dialog.current?.close();
  }, [signing]);
  useEffect(() => {
    if (!pendingAuthorization || !wallet.session || wallet.session.locked || busy || wallet.busy) return;
    setPendingAuthorization(false);
    void authorize();
  }, [pendingAuthorization, key, busy, wallet.busy]);

  function unlock(expected?: string) {
    setError("");
    setExpectedAddress(expected ?? null);
    setUnlockOpen(true);
  }

  function closeUnlock() {
    setUnlockOpen(false);
    setPendingAuthorization(false);
  }

  async function signOut() {
    revokeToken();
    closeUnlock();
    forgetLastUsedAccount();
    await wallet.disconnect();
  }

  async function authenticate() {
    if (key !== current.current) throw new Error("Wallet changed.");
    if (!wallet.session || wallet.session.locked) throw new Error("Connect and unlock your wallet first.");
    if (token.current?.key === key && token.current.expires > Date.now()) return;
    if (authentication.current?.key === key) return authentication.current.promise;
    const captured = key;
    const promise = (async () => {
      setSigning(wallet.session!.kind !== "builtin");
      try {
        const result = await wallet.runOperation(async (session, isCurrent) => {
          const challenge = await apiRequest<{
            id: string;
            message: string
          }>(origin, "/auth/challenge", undefined, {address: session.address});
          if (!isCurrent()) throw new Error("Wallet changed.");
          const supplied = session.signAppAuthentication ? await session.signAppAuthentication(challenge.message, window.location.origin) : await session.signMessage(challenge.message);
          if (!isCurrent()) throw new Error("Wallet changed.");
          const verified = await apiRequest<{
            token: string;
            expiresAt: string
          }>(origin, "/auth/verify", undefined, {
            id: challenge.id,
            signature: typeof supplied === "string" ? supplied : hexlify(supplied)
          });
          if (!isCurrent() || captured !== current.current) throw new Error("Wallet changed.");
          return verified;
        });
        token.current = {key: captured, value: result.token, expires: Date.parse(result.expiresAt)};
        setGrant({key: captured, expires: token.current.expires});
      } finally {
        setSigning(false);
      }
    })();
    authentication.current = {key, promise};
    try {
      await promise;
    } finally {
      if (authentication.current?.promise === promise) authentication.current = null;
    }
  }

  async function authorize(expected?: string) {
    if (busy || wallet.busy) return;
    setError("");
    if (!wallet.session || wallet.session.locked) {
      setPendingAuthorization(true);
      unlock(expected);
      return;
    }
    setBusy(true);
    try {
      await authenticate();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function request<T>(path: string, body?: unknown, method?: string) {
    const captured = key;
    if (captured !== current.current) throw new Error("Wallet changed.");
    // An expired grant must never cause a background refresh to open a wallet.
    if (grant?.key === key && (!token.current || token.current.expires <= Date.now())) {
      setGrant(null);
      throw new Error("Sign in again to continue. Public orders remain available.");
    }
    await authenticate();
    if (captured !== current.current) throw new Error("Wallet changed.");
    try {
      if (token.current?.key !== captured) throw new Error("Wallet changed.");
      const result = await apiRequest<T>(origin, path, token.current.value, body, method);
      if (captured !== current.current) throw new Error("Wallet changed.");
      return result;
    } catch (error) {
      if (captured === current.current && error instanceof ApiError && /SESSION|AUTH/.test(error.code)) {
        token.current = null;
        setGrant(null);
      }
      throw error;
    }
  }

  return <AccessContext.Provider value={{
    address: wallet.session?.address ?? wallet.lastUsed?.address ?? null,
    authenticated: !!wallet.session && !wallet.session.locked && grant?.key === key && grant.expires > Date.now(),
    busy: busy || wallet.busy,
    error,
    authorize,
    unlock,
    signOut
  }}><MediaOriginContext.Provider value={origin}><Context.Provider value={{
    read: path => apiRequest(origin, path),
    request
  }}>{children}</Context.Provider></MediaOriginContext.Provider>
    <UnlockDialog open={unlockOpen} expectedAddress={expectedAddress} onClose={closeUnlock}
                  onConnected={() => setUnlockOpen(false)}/>
    <dialog className="approval-dialog" ref={dialog} onCancel={e => {
      e.preventDefault();
      setSigning(false);
    }}>
      <h2>Sign in to PayUnlock</h2>
      <p>Confirm wallet ownership to access protected features. This signature costs no gas and does not authorize a
        payment.</p>
      <p>Approve or reject the request in your wallet.</p>
    </dialog>
  </AccessContext.Provider>;
}

export function useCommerce() {
  const value = useContext(Context);
  if (!value) throw new Error("CommerceProvider missing.");
  return value;
}

export function useCommerceAccess() {
  const value = useContext(AccessContext);
  if (!value) throw new Error("CommerceProvider missing.");
  return value;
}

export function ProtectedAccess({
                                  children,
                                  label = "Access protected features",
                                  description = "Public orders do not require signing. Continue when you need private data or order actions."
                                }: { children: ReactNode; label?: string; description?: string }) {
  const access = useCommerceAccess();
  if (access.authenticated) return children;
  return <section className="card">{description && <p>{description}</p>}<Button
    icon={access.address ? ButtonArrowRight : ButtonWallet} disabled={access.busy}
    onClick={() => access.authorize()}>{label}</Button>{access.error && <p role="alert">{access.error}</p>}</section>;
}
