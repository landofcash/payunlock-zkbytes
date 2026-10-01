import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { KeyRound, LockKeyhole, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyableField } from "@/components/CopyableField";
import { AccountNameLabel } from "./AccountName";
import { ACCOUNT_NAMES_EVENT, ACCOUNT_NAMES_KEY, ensureAccountNames, savedAccountNames } from "./account-names";
import { IndexedStore } from "@/storage/local-store";
import { useApproval } from "./ApprovalProvider";
import { unlockWallet } from "./managed-session";
import { canUsePasskeys, openPasskeySession, passkeyError } from "./passkey";
import { savedPasskeyAccounts, type SavedPasskeyAccount } from "./saved-passkeys";
import { useSession } from "./session-store";
import { WalletVault } from "./vault";
import { reownProjectId } from "@/config/reown";
import metamaskLogo from "@/assets/metamask.svg";
import walletConnectLogo from "@/assets/walletconnect.svg";
import { requestWalletMenuOpen } from "./wallet-menu-events";

const vault = new WalletVault(new IndexedStore());
const short = (address: string) => `${address.slice(0, 8)}...${address.slice(-6)}`;

export function UnlockDialog({ open, expectedAddress, onClose, onConnected }: {
  open: boolean;
  expectedAddress: string | null;
  onClose(): void;
  onConnected(): void;
}) {
  const wallet = useSession(), approve = useApproval();
  const dialog = useRef<HTMLDialogElement>(null);
  const [accounts, setAccounts] = useState<string[]>([]);
  const [passkeys, setPasskeys] = useState<SavedPasskeyAccount[]>([]);
  const [accountNames, setAccountNames] = useState(savedAccountNames);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [showAll, setShowAll] = useState(false);
  const pending = useRef(false);
  useEffect(() => {
    if (!open) { dialog.current?.close(); setPassword(""); setSelected(null); setError(""); setShowAll(false); return; }
    dialog.current?.showModal();
    setLoading(true);
    let active = true;
    const savedPasskeys = savedPasskeyAccounts();
    setPasskeys(savedPasskeys);
    setAccountNames(savedAccountNames());
    void vault.list().then(list => {
      if (!active) return;
      setAccounts(list);
      setAccountNames(ensureAccountNames([...list, ...savedPasskeys.map(account => account.address)]));
      const remembered = wallet.lastUsed;
      if (remembered?.kind === "password" && (!expectedAddress || remembered.address.toLowerCase() === expectedAddress.toLowerCase()) && list.some(address => address.toLowerCase() === remembered.address.toLowerCase())) setSelected(remembered.address);
    }).catch(() => { if (active) setError("Local wallet storage is unavailable."); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const refresh = () => setAccountNames(savedAccountNames());
    const sync = (event: StorageEvent) => { if (event.key === ACCOUNT_NAMES_KEY || event.key === null) refresh(); };
    window.addEventListener(ACCOUNT_NAMES_EVENT, refresh); window.addEventListener("storage", sync);
    return () => { window.removeEventListener(ACCOUNT_NAMES_EVENT, refresh); window.removeEventListener("storage", sync); };
  }, [open]);
  useEffect(() => {
    if (!open || !wallet.session || wallet.session.locked) return;
    if (expectedAddress && wallet.session.address.toLowerCase() !== expectedAddress.toLowerCase()) {
      setError(`This action needs ${short(expectedAddress)}. The connected wallet is ${short(wallet.session.address)}.`);
      void wallet.disconnect();
      return;
    }
    onConnected();
  }, [open, wallet.sessionEpoch]);
  const remembered = wallet.lastUsed;
  const preferred = remembered && (!expectedAddress || remembered.address.toLowerCase() === expectedAddress.toLowerCase()) ? remembered : null;
  const availablePreferred = preferred?.kind === "password" && !accounts.some(address => address.toLowerCase() === preferred.address.toLowerCase()) ? null : preferred;
  const passkeyAvailable = canUsePasskeys();
  const disabled = busy || wallet.busy;
  async function passwordSignIn(event: FormEvent) {
    event.preventDefault();
    if (!selected || pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const session = await unlockWallet(vault, selected, password, approve);
      if (expectedAddress && session.address.toLowerCase() !== expectedAddress.toLowerCase()) { session.dispose?.(); throw new Error("This password account does not match the account needed for this action."); }
      await wallet.connectBuiltIn(session);
    } catch { setError("Could not unlock this account. Check the password and try again."); }
    finally { setPassword(""); pending.current = false; setBusy(false); }
  }
  async function passkeySignIn(account?: SavedPasskeyAccount) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const session = await openPasskeySession("signin", approve, account);
      if (expectedAddress && session.address.toLowerCase() !== expectedAddress.toLowerCase()) { session.dispose?.(); throw new Error("This passkey belongs to a different account."); }
      await wallet.connectBuiltIn(session);
    } catch (cause) { setError(cause instanceof Error && cause.message === "This passkey belongs to a different account." ? cause.message : passkeyError(cause)); }
    finally { pending.current = false; setBusy(false); }
  }
  async function externalSignIn(kind: "metamask" | "walletconnect") {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await (kind === "metamask" ? wallet.connectMetaMask() : wallet.connectWalletConnect()); }
    finally { pending.current = false; setBusy(false); }
  }
  function accountInfo(address: string, kind: "password" | "passkey") {
    return <div className="unlock-account-info"><div className="unlock-account-heading"><AccountNameLabel name={accountNames[address.toLowerCase()] ?? "Your account"} /><span className="muted">{kind === "passkey" ? "Passkey" : "Password"}</span></div><CopyableField hideLabel label="Address" value={address} displayValue={short(address)} /></div>;
  }
  function accountButton(address: string, kind: "password" | "passkey", passkey?: SavedPasskeyAccount) {
    return <article className="wallet-account" key={`${kind}:${address}`}>{accountInfo(address, kind)}<Button icon={kind === "passkey" ? KeyRound : LockKeyhole} disabled={disabled || (kind === "passkey" && !passkeyAvailable)} onClick={() => { if (kind === "passkey") void passkeySignIn(passkey); else { setPassword(""); setError(""); setSelected(address); } }}>{kind === "passkey" ? "Sign in with passkey" : "Sign in"}</Button></article>;
  }
  function chooseAnother() { setSelected(null); setPassword(""); setError(""); setShowAll(true); }
  function footer(choose: boolean) {
    return <div className="unlock-dialog-footer">{choose && <Button variant="link" disabled={disabled} onClick={chooseAnother}>Choose another account</Button>}<Button className="unlock-dialog-cancel" variant="ghost" disabled={disabled} onClick={onClose}>Cancel</Button></div>;
  }
  return createPortal(<dialog ref={dialog} className="approval-dialog wallet-action-dialog unlock-dialog" aria-labelledby="unlock-dialog-title" onCancel={event => { event.preventDefault(); if (!disabled) onClose(); }}>
    <div className="section-heading"><h2 id="unlock-dialog-title">Sign in to continue</h2><Button icon={X} variant="ghost" size="icon" aria-label="Close sign-in dialog" disabled={disabled} onClick={onClose} /></div>
    {expectedAddress && <p>Use the account needed for this action: <strong>{short(expectedAddress)}</strong></p>}
    {loading ? <p role="status">Loading accounts...</p> : selected ? <><form onSubmit={event => void passwordSignIn(event)}><div className="wallet-account">{accountInfo(selected, "password")}</div><label>Password<input type="password" autoComplete="current-password" minLength={12} maxLength={1024} required value={password} onChange={event => setPassword(event.target.value)} disabled={disabled} autoFocus /></label><Button className="unlock-dialog-submit" type="submit" icon={LockKeyhole} disabled={disabled} loading={busy}>Sign in</Button></form>{footer(true)}</> : <>
      {availablePreferred && !showAll && <div className="wallet-account-list">{availablePreferred.kind === "passkey" ? accountButton(availablePreferred.address, "passkey", { address: availablePreferred.address, credentialId: availablePreferred.credentialId!, rpId: availablePreferred.rpId! }) : availablePreferred.kind === "password" ? accountButton(availablePreferred.address, "password") : <Button disabled={disabled} onClick={() => void externalSignIn(availablePreferred.kind as "metamask" | "walletconnect")}>Reconnect {availablePreferred.kind === "metamask" ? "MetaMask" : "WalletConnect"} · {short(availablePreferred.address)}</Button>}</div>}
      {(!availablePreferred || showAll) && <><Button icon={KeyRound} disabled={disabled || !passkeyAvailable} onClick={() => void passkeySignIn()}>Sign in with passkey</Button><div className="wallet-account-list">{accounts.map(address => accountButton(address, "password"))}{passkeys.map(account => accountButton(account.address, "passkey", account))}</div><div className="wallet-provider-buttons"><Button variant="secondary" disabled={disabled} onClick={() => void externalSignIn("metamask")}><img src={metamaskLogo} alt="" aria-hidden="true" />Connect MetaMask</Button><Button variant="secondary" disabled={disabled || !reownProjectId} onClick={() => void externalSignIn("walletconnect")}><img src={walletConnectLogo} alt="" aria-hidden="true" />Connect WalletConnect</Button></div><Button variant="ghost" disabled={disabled} onClick={() => { onClose(); requestWalletMenuOpen(); }}>Create or import account</Button></>}
      {footer(!!availablePreferred && !showAll)}
    </>}
    {(error || wallet.error) && <p role="alert">{error || wallet.error}</p>}
  </dialog>, document.body);
}
