import { useEffect, useRef, useState, type FormEvent } from "react";
import { IndexedStore } from "@/storage/local-store";
import { WalletVault } from "./vault";
import { unlockWallet, type Approval } from "./managed-session";
import { useSession } from "./session-store";
import { reownProjectId } from "@/config/reown";

const vault = new WalletVault(new IndexedStore());
export function WalletPage() {
  const wallet = useSession();
  const [address, setAddress] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [importText, setImportText] = useState("");
  const [mode, setMode] = useState("unlock");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [backup, setBackup] = useState("");
  const [label, setLabel] = useState("personal");
  const [approval, setApproval] = useState<Parameters<Approval>[0] | null>(null);
  const resolveApproval = useRef<((allow: boolean) => void) | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    void vault.selected().then(setAddress).catch(() => setError("Local wallet storage is unavailable."));
    return () => { mounted.current = false; resolveApproval.current?.(false); };
  }, []);
  useEffect(() => {
    setBackup(""); setPassword("");
    resolveApproval.current?.(false); resolveApproval.current = null; setApproval(null);
  }, [wallet.sessionEpoch]);
  useEffect(() => {
    if (approval) dialog.current?.showModal(); else dialog.current?.close();
  }, [approval]);
  useEffect(() => {
    if (!backup) return;
    const hide = () => setBackup("");
    const timer = setTimeout(hide, 60_000);
    window.addEventListener("pagehide", hide);
    return () => { clearTimeout(timer); window.removeEventListener("pagehide", hide); };
  }, [backup]);
  const approve: Approval = request => new Promise(resolve => {
    if (!mounted.current) { resolve(false); return; }
    resolveApproval.current = resolve; setApproval(request);
  });
  function answer(allow: boolean) { resolveApproval.current?.(allow); resolveApproval.current = null; setApproval(null); }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setError(""); setBackup("");
    try {
      if (mode === "create" || mode === "import") {
        if (password !== confirmation) throw new Error("Passphrases do not match.");
        const selected = mode === "create" ? await vault.create(password) : await vault.import(importText, password);
        if (mounted.current) { setAddress(selected); setMode("unlock"); }
      } else if (mode === "export") {
        if (!address) throw new Error("Create or import a wallet first.");
        const secret = await vault.export(address, password);
        if (mounted.current) setBackup(secret.mnemonic ? `Recovery phrase:\n${secret.mnemonic}\n\nPrivate key:\n${secret.privateKey}` : `Private key:\n${secret.privateKey}`);
        secret.privateKey = ""; secret.mnemonic = null;
      } else {
        if (!address) throw new Error("Create or import a wallet first.");
        const session = await unlockWallet(vault, address, password, approve);
        if (!mounted.current) session.lock(); else await wallet.connectBuiltIn(session);
      }
    } catch { if (mounted.current) setError("Could not complete the wallet action. Check the selected wallet, recovery input, and passphrase."); }
    finally { if (mounted.current) { setPassword(""); setConfirmation(""); setImportText(""); setBusy(false); } }
  }
  return <section className="wallet-page"><h1>Your wallet</h1>
    <p>Monad Testnet. Use test funds only. Purchasing is not available yet.</p>
    {wallet.session ? <><p className="wallet-address">{wallet.session.walletName}: {wallet.session.address}</p><button onClick={() => { answer(false); setBackup(""); void wallet.disconnect(); }}>Lock and disconnect</button>
      <button disabled={wallet.busy} onClick={() => void wallet.testCompatibility()}>Check signing compatibility</button><p>Compatibility: {wallet.compatibility}</p>
      <label>Receiving identity label<input value={label} onChange={event => setLabel(event.target.value)} /></label><button disabled={wallet.busy} onClick={() => void wallet.restoreIdentity(label)}>Restore receiving identity</button>
      {wallet.identities.map(identity => <p className="wallet-address" key={identity.publicKey}>{identity.label}: {identity.publicKey}</p>)}
    </> : <div className="wallet-actions"><button disabled={wallet.busy || busy} onClick={() => void wallet.connectMetaMask()}>Connect MetaMask</button><button disabled={wallet.busy || busy || !reownProjectId} onClick={() => void wallet.connectWalletConnect()}>Connect WalletConnect</button></div>}
    {(wallet.error || error) && <p role="alert">{error || wallet.error}</p>}{wallet.notice && <p role="status">{wallet.notice}</p>}
    <h2>Built-in wallet</h2><p className="wallet-address">{address ?? "No local wallet selected"}</p>
    <p>Your passphrase unlocks this browser’s encrypted wallet. Keep the recovery phrase or private key separately: the passphrase alone cannot restore a lost browser wallet. Sessions lock after five minutes.</p>
    <form onSubmit={event => void submit(event)}>
      <label>Action<select value={mode} onChange={event => { setMode(event.target.value); setBackup(""); }}><option value="unlock">Unlock</option><option value="create">Create wallet</option><option value="import">Import wallet</option><option value="export">Show recovery material</option></select></label>
      {mode === "import" && <label>Recovery phrase or private key<textarea autoComplete="off" spellCheck={false} value={importText} onChange={event => setImportText(event.target.value)} /></label>}
      <label>Local passphrase<input type="password" autoComplete="off" minLength={12} maxLength={1024} required value={password} onChange={event => setPassword(event.target.value)} /></label>
      {(mode === "create" || mode === "import") && <label>Confirm passphrase<input type="password" autoComplete="off" required value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>}
      <button disabled={busy || wallet.busy || !!wallet.session}>{busy ? "Working…" : "Continue"}</button>
    </form>
    {backup && <section><p>Keep this private. Anyone with these values can control your wallet.</p><pre className="wallet-address">{backup}</pre><button onClick={() => setBackup("")}>Hide recovery material</button></section>}
    <dialog ref={dialog} onCancel={event => { event.preventDefault(); answer(false); }}><h2>Review signing request</h2><p>Unlocking your wallet does not approve this request.</p><pre>{approval?.kind === "message" ? approval.message : approval ? JSON.stringify(approval.transaction, (_, value: unknown) => typeof value === "bigint" ? value.toString() : value, 2) : ""}</pre><button onClick={() => answer(false)}>Cancel</button><button onClick={() => answer(true)}>Approve signature</button></dialog>
  </section>;
}
