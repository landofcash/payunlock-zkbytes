import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { checkCompatibility } from "./compatibility";
import {
  deriveIdentity,
  validateLabel,
  type ReceivingIdentity,
} from "@/exchange/identity";
import {
  walletErrorKind,
  WalletError,
  walletErrorMessages,
  type WalletErrorKind,
} from "./errors";
import { metamaskAdapter } from "./metamask-adapter";
import { IDENTITY_PROFILE } from "@/exchange/identity";
import {
  IDENTITY_STORAGE_KEY,
  identityId,
  mergeIdentities,
  readSavedIdentities,
  parseIdentityBackup,
  serializeIdentityBackup,
  type SavedIdentity,
} from "@/exchange/saved-identities";
import type { LabWalletAdapter, LabWalletSession } from "./types";
import { clearItemKeys, encodeBase64, type ItemKeyPair } from "@zkbytes/sdk";
import { canonical } from "@/crypto/encoding";
import { restoreReceivingKeys, type ReceivingContext } from "@/commerce/protocol";
import { VAULT_EVENT, VAULT_CHANGE_KEY } from "./vault";
import { LAST_USED_EVENT, LAST_USED_KEY, readLastUsedAccount, rememberLastUsedAccount, type LastUsedAccount } from "./last-used";
export const IDLE_LOCK_MS = 2 * 60 * 1000;

type Compatibility =
  "untested" | "checking" | "compatible" | "nondeterministic" | WalletErrorKind;
export type WalletAction = {
  action:
    "restore" | "encrypt" | "endorse" | "compatibility" | "delete" | "sign";
  label?: string;
};
export type WalletActivity = WalletAction & {
  walletName: string;
  phase: "approval" | "processing";
};
type SessionState = {
  lastUsed: LastUsedAccount | null;
  walletActivity: WalletActivity | null;
  savedIdentities: SavedIdentity[];
  storageError: string | null;
  importIdentities(text: string): void;
  clearSavedIdentities(): void;
  sessionEpoch: number;
  identityEpoch: number;
  runIdentityOperation<T>(
    publicKey: string,
    operation: (privateKey: Uint8Array, isCurrent: () => boolean) => Promise<T>,
  ): Promise<T>;
  runOfferKeysOperation<T>(context: ReceivingContext, expectedPublicKey: string | undefined,
    operation: (keys: ItemKeyPair, session: LabWalletSession, isCurrent: () => boolean) => Promise<T>): Promise<T>;
  runOperation<T>(
    operation: (
      session: LabWalletSession,
      isCurrent: () => boolean,
    ) => Promise<T>,
    action?: WalletAction,
  ): Promise<T>;
  identities: { label: string; publicKey: string }[];
  restoreIdentity(label: string): Promise<string | undefined>;
  lockIdentities(): void;
  session: LabWalletSession | null;
  busy: boolean;
  compatibility: Compatibility;
  error: string | null;
  notice: string | null;
  connectMetaMask(): Promise<void>;
  connectBuiltIn(session: LabWalletSession): Promise<void>;
  connectWalletConnect(): Promise<void>;
  connectFixture(): Promise<void>;
  disconnect(): Promise<void>;
  switchNetwork(): Promise<void>;
  testCompatibility(): Promise<void>;
};
const Context = createContext<SessionState | null>(null);
export function SessionProvider({ children }: { children: ReactNode }) {
  const [lastUsed, setLastUsed] = useState(readLastUsedAccount);
  const [saved, setSaved] = useState(() => {
    try {
      return {
        identities: readSavedIdentities(),
        error: null as string | null,
      };
    } catch {
      return {
        identities: [] as SavedIdentity[],
        error:
          "Saved identities could not be read. Browser storage may be unavailable or the data invalid. Export any available list before clearing it.",
      };
    }
  });
  const savedRef = useRef(saved.identities);
  function updateSaved(identities: SavedIdentity[]) {
    savedRef.current = identities;
    setSaved({ identities, error: null });
  }
  function saveIdentities(incoming: SavedIdentity[]) {
    const next = mergeIdentities(readSavedIdentities(), incoming);
    localStorage.setItem(IDENTITY_STORAGE_KEY, serializeIdentityBackup(next));
    updateSaved(next);
  }
  function importIdentities(text: string) {
    const incoming = parseIdentityBackup(text);
    saveIdentities(incoming);
  }
  function clearSavedIdentities() {
    // Remove only this app's identity list, never unrelated origin/wallet data.
    localStorage.removeItem(IDENTITY_STORAGE_KEY);
    updateSaved([]);
    lockIdentities();
    setError(null);
  }
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const [identityEpoch, setIdentityEpoch] = useState(0);
  const [walletActivity, setWalletActivity] = useState<WalletActivity | null>(
    null,
  );
  const privateIdentities = useRef<ReceivingIdentity[]>([]);
  const offerKeys = useRef(new Map<string, ItemKeyPair>());
  const [identities, setIdentities] = useState<SessionState["identities"]>([]);
  function clearPrivateIdentities() {
    offerKeys.current.forEach(clearItemKeys);
    offerKeys.current.clear();
    setWalletActivity(null);
    setIdentityEpoch((value) => value + 1);
    privateIdentities.current.forEach((identity) =>
      identity.privateKey.fill(0),
    );
    privateIdentities.current = [];
  }
  function lockIdentities() {
    revision.current++;
    clearPrivateIdentities();
    setIdentities([]);
    if (current.current?.kind === "builtin") current.current.dispose?.();
    setCompatibility((value) => (value === "checking" ? "untested" : value));
  }
  const [session, setSession] = useState<LabWalletSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [compatibility, setCompatibility] = useState<Compatibility>("untested");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const current = useRef<LabWalletSession | null>(null);
  const revision = useRef(0);
  const locked = useRef(false);
  const mounted = useRef(true);
  const unsubscribe = useRef<(() => void) | undefined>(undefined);

  function trackedSigner(
    selected: LabWalletSession,
    isCurrent: () => boolean,
    action: WalletAction,
  ): LabWalletSession {
    return {
      ...selected,
      async signMessage(message) {
        if (!isCurrent()) throw new WalletError("wrong-account");
        // The development fixture does not open an external wallet prompt.
        if (selected.kind !== "fixture")
          setWalletActivity({
            ...action,
            walletName: selected.walletName,
            phase: "approval",
          });
        const signature = await selected.signMessage(message);
        if (isCurrent() && selected.kind !== "fixture")
          setWalletActivity({
            ...action,
            walletName: selected.walletName,
            phase: "processing",
          });
        return signature;
      },
      signTypedData: selected.signTypedData ? async request => {
        if (!isCurrent()) throw new WalletError("wrong-account");
        if (selected.kind !== "fixture") setWalletActivity({ ...action, walletName: selected.walletName, phase: "approval" });
        const signature = await selected.signTypedData!(request);
        if (isCurrent() && selected.kind !== "fixture") setWalletActivity({ ...action, walletName: selected.walletName, phase: "processing" });
        return signature;
      } : undefined,
    };
  }

  useEffect(() => {
    mounted.current = true;
    const hide = () => {
      const previous = current.current;
      unsubscribe.current?.();
      unsubscribe.current = undefined;
      current.current = null;
      setSession(null);
      setSessionEpoch((value) => value + 1);
      revision.current++;
      clearPrivateIdentities();
      setIdentities([]);
      setCompatibility("untested");
      if (previous?.kind === "builtin") previous.dispose?.();
    };
    window.addEventListener("pagehide", hide);
    const storage = (event: StorageEvent) => {
      if (event.key !== IDENTITY_STORAGE_KEY && event.key !== null) return;
      hide();
      try {
        updateSaved(readSavedIdentities());
      } catch {
        setSaved((value) => ({
          ...value,
          error:
            "Saved identities changed but could not be read. Recheck browser storage before restoring.",
        }));
      }
    };
    window.addEventListener("storage", storage);
    return () => {
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("storage", storage);
      clearPrivateIdentities();
      mounted.current = false;
      revision.current++;
      unsubscribe.current?.();
      current.current?.dispose?.();
      current.current = null;
    };
  }, []);

  useEffect(() => {
    const refresh = () => setLastUsed(readLastUsedAccount());
    const storage = (event: StorageEvent) => { if (event.key === LAST_USED_KEY || event.key === null) refresh(); };
    window.addEventListener(LAST_USED_EVENT, refresh);
    window.addEventListener("storage", storage);
    return () => { window.removeEventListener(LAST_USED_EVENT, refresh); window.removeEventListener("storage", storage); };
  }, []);

  useEffect(() => {
    if (!session) return;
    // A fixed absolute lifetime: status reads and React rerenders never extend it.
    const timer = setTimeout(() => { void disconnect(); }, 5 * 60 * 1000);
    return () => clearTimeout(timer);
  }, [sessionEpoch]);

  useEffect(() => {
    if (session?.kind !== "builtin") return;
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => { clearTimeout(timer); timer = setTimeout(() => { void disconnect(); }, IDLE_LOCK_MS); };
    const revoke = () => { void disconnect(); };
    const storage = (event: StorageEvent) => { if (event.key === VAULT_CHANGE_KEY || event.key === null) revoke(); };
    reset(); window.addEventListener("pointerdown", reset); window.addEventListener("keydown", reset);
    window.addEventListener(VAULT_EVENT, revoke); window.addEventListener("storage", storage);
    return () => { clearTimeout(timer); window.removeEventListener("pointerdown", reset); window.removeEventListener("keydown", reset); window.removeEventListener(VAULT_EVENT, revoke); window.removeEventListener("storage", storage); };
  }, [sessionEpoch]);

  async function connect(loadAdapter: () => Promise<LabWalletAdapter>) {
    if (locked.current || current.current) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    const id = ++revision.current;
    try {
      const adapter = await loadAdapter();
      const next = await adapter.connect();
      if (!mounted.current || id !== revision.current) {
        next.dispose?.();
        return;
      }
      current.current = next;
      if (next.kind !== "fixture") setLastUsed(rememberLastUsedAccount(next));
      setSessionEpoch((value) => value + 1);
      setSession({ ...next });
      setCompatibility("untested");
      unsubscribe.current = next.subscribe?.((event) => {
        if (current.current !== next) return;
        revision.current++;
        setSessionEpoch((value) => value + 1);
        clearPrivateIdentities();
        setIdentities([]);
        setCompatibility("untested");
        setError(null);
        if (event === "disconnect") {
          unsubscribe.current?.();
          next.dispose?.();
          current.current = null;
          setSession(null);
          setNotice("Wallet disconnected. Connect again to continue.");
        } else {
          if (event === "accountsChanged") setLastUsed(rememberLastUsedAccount(next));
          setSession({ ...next });
          setNotice(
            event === "accountsChanged"
              ? "Account changed. Restore your receiving keys again when needed."
              : "Network changed. Receiving keys have been cleared.",
          );
        }
        // Keep the prompt lock until the original request settles.
      });
    } catch (cause) {
      if (mounted.current && id === revision.current)
        setError(walletErrorMessages[walletErrorKind(cause)]);
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function connectMetaMask() {
    await connect(async () => metamaskAdapter);
  }
  async function connectBuiltIn(session: LabWalletSession) {
    if (locked.current || current.current) { session.dispose?.(); throw new Error("Disconnect the current wallet first."); }
    await connect(async () => ({ kind: "builtin", label: "Built-in wallet", connect: async () => session }));
  }
  async function connectFixture() {
    if (!import.meta.env.DEV) return;
    await connect(
      async () => (await import("./fixture-adapter")).fixtureAdapter,
    );
  }
  async function connectWalletConnect() {
    await connect(
      async () =>
        (await import("./walletconnect-adapter")).walletconnectAdapter,
    );
  }
  async function disconnect() {
    // Lock/disconnect must invalidate a pending approval immediately.
    const hadPendingOperation = locked.current;
    locked.current = true;
    setBusy(true);
    revision.current++;
    clearPrivateIdentities();
    setIdentities([]);
    const previous = current.current;
    setSessionEpoch((value) => value + 1);
    unsubscribe.current?.();
    unsubscribe.current = undefined;
    current.current = null;
    setSession(null);
    setCompatibility("untested");
    setError(null);
    setNotice(null);
    try {
      await previous?.disconnect();
    } catch {
      if (mounted.current)
        setNotice(
          "Disconnected locally. If your wallet still lists this site, disconnect it in the wallet too.",
        );
    } finally {
      if (!hadPendingOperation) {
        locked.current = false;
        if (mounted.current) setBusy(false);
      }
    }
  }
  async function switchNetwork() {
    const selected = current.current;
    if (!selected?.switchNetwork || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    revision.current++;
    clearPrivateIdentities();
    setIdentities([]);
    setCompatibility("untested");
    try {
      await selected.switchNetwork();
    } catch (cause) {
      if (mounted.current && current.current === selected)
        setError(walletErrorMessages[walletErrorKind(cause)]);
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function testCompatibility() {
    const selected = current.current;
    if (!selected || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    setCompatibility("checking");
    const id = ++revision.current;
    const isCurrent = () =>
      mounted.current &&
      revision.current === id &&
      current.current === selected;
    try {
      const reproducible = await checkCompatibility(
        trackedSigner(selected, isCurrent, { action: "compatibility" }),
        isCurrent,
      );
      if (isCurrent())
        setCompatibility(reproducible ? "compatible" : "nondeterministic");
    } catch (cause) {
      if (isCurrent()) {
        const kind = walletErrorKind(cause);
        setCompatibility(kind);
        setError(walletErrorMessages[kind]);
      }
    } finally {
      locked.current = false;
      if (mounted.current) {
        setWalletActivity(null);
        setBusy(false);
      }
    }
  }
  async function restoreIdentity(label: string) {
    const selected = current.current;
    if (!selected || locked.current) return;
    try {
      validateLabel(label);
    } catch (cause) {
      setError((cause as Error).message);
      return;
    }
    locked.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    const id = ++revision.current;
    const isCurrent = () =>
      mounted.current &&
      revision.current === id &&
      current.current === selected;
    try {
      const identity = await deriveIdentity(
        trackedSigner(selected, isCurrent, { action: "restore", label }),
        label,
        isCurrent,
      );
      if (!isCurrent()) {
        identity.privateKey.fill(0);
        return;
      }
      const existing = privateIdentities.current.find(
        (item) => item.label === label,
      );
      const remembered = savedRef.current.find(
        (item) =>
          identityId(item) ===
          identityId({ walletAddress: selected.address, label }),
      );
      if (
        (existing && existing.publicKey !== identity.publicKey) ||
        (remembered && remembered.publicKey !== identity.publicKey)
      ) {
        identity.privateKey.fill(0);
        clearPrivateIdentities();
        setIdentities([]);
        setCompatibility(existing ? "nondeterministic" : "untested");
        setError(
          "The restored key differs from the saved key for this wallet and label. Receiving keys were cleared; the saved record was not replaced. Check the wallet, backup and signing compatibility.",
        );
        return;
      }
      existing?.privateKey.fill(0);
      privateIdentities.current = [
        ...privateIdentities.current.filter((item) => item.label !== label),
        identity,
      ];
      setIdentities(
        privateIdentities.current.map(({ label, publicKey }) => ({
          label,
          publicKey,
        })),
      );
      try {
        saveIdentities([
          {
            walletAddress: selected.address.toLowerCase(),
            walletKind: selected.kind,
            label,
            publicKey: identity.publicKey,
            profile: IDENTITY_PROFILE,
          },
        ]);
      } catch {
        setSaved((value) => ({
          ...value,
          error:
            "Keys are available for this session, but the identity could not be saved. Browser storage may be unavailable, full, or contain conflicting data.",
        }));
      }
      return identity.publicKey;
    } catch (cause) {
      if (isCurrent()) setError(walletErrorMessages[walletErrorKind(cause)]);
    } finally {
      locked.current = false;
      if (mounted.current) {
        setWalletActivity(null);
        setBusy(false);
      }
    }
  }
  async function runOperation<T>(
    operation: (
      session: LabWalletSession,
      isCurrent: () => boolean,
    ) => Promise<T>,
    action: WalletAction = { action: "sign" },
  ): Promise<T> {
    const selected = current.current;
    if (locked.current) throw new WalletError("pending");
    if (!selected) throw new WalletError("disconnected");
    locked.current = true;
    setBusy(true);
    const id = revision.current;
    const isCurrent = () =>
      mounted.current &&
      revision.current === id &&
      current.current === selected;
    try {
      return await operation(
        trackedSigner(selected, isCurrent, action),
        isCurrent,
      );
    } finally {
      locked.current = false;
      if (mounted.current) {
        setWalletActivity(null);
        setBusy(false);
      }
    }
  }
  async function runIdentityOperation<T>(
    publicKey: string,
    operation: (privateKey: Uint8Array, isCurrent: () => boolean) => Promise<T>,
  ): Promise<T> {
    return runOperation(async (_session, isCurrent) => {
      const identity = privateIdentities.current.find(
        (value) => value.publicKey === publicKey,
      );
      if (!identity) throw new Error("Restore the receiving identity first.");
      return operation(identity.privateKey, isCurrent);
    });
  }
  async function runOfferKeysOperation<T>(context: ReceivingContext, expectedPublicKey: string | undefined,
    operation: (keys: ItemKeyPair, session: LabWalletSession, isCurrent: () => boolean) => Promise<T>) {
    return runOperation(async (session, isCurrent) => {
      if (session.address.toLowerCase() !== context.account || !isCurrent()) throw new Error("Wrong offer account or session.");
      const id = canonical(context);
      let keys = offerKeys.current.get(id);
      if (!keys) {
        keys = await restoreReceivingKeys(context, session, isCurrent, expectedPublicKey);
        if (!isCurrent()) { clearItemKeys(keys); throw new Error("Session changed."); }
        offerKeys.current.set(id, keys);
      }
      if (expectedPublicKey && encodeBase64(keys.encryptionPublicKey) !== expectedPublicKey) throw new Error("Offer key does not match the purchased seller identity.");
      const result = await operation(keys, session, isCurrent);
      if (!isCurrent()) throw new Error("Session changed.");
      return result;
    }, { action: "restore", label: "Offer delivery keys" });
  }
  return (
    <Context.Provider
      value={{
        lastUsed,
        walletActivity,
        savedIdentities: saved.identities,
        storageError: saved.error,
        importIdentities,
        clearSavedIdentities,
        sessionEpoch,
        identityEpoch,
        runIdentityOperation,
        runOfferKeysOperation,
        runOperation,
        identities,
        restoreIdentity,
        lockIdentities,
        session,
        busy,
        compatibility,
        error,
        notice,
        connectMetaMask,
        connectBuiltIn,
        connectWalletConnect,
        connectFixture,
        disconnect,
        switchNetwork,
        testCompatibility,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useSession() {
  const value = useContext(Context);
  if (!value) throw new Error("SessionProvider missing.");
  return value;
}
