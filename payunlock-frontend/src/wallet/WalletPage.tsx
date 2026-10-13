import {type FormEvent, useEffect, useRef, useState} from "react";
import {Link, useLocation, useNavigate} from "react-router-dom";
import {createPortal} from "react-dom";
import {
  Check,
  ExternalLink,
  Eye,
  KeyRound,
  LockKeyhole,
  LogOut,
  Network,
  Plus,
  Scale,
  ShieldCheck,
  SlidersHorizontal,
  Star,
  Trash2,
  Upload,
  Wallet,
  X
} from "lucide-react";
import {RecoveryBackup, RecoveryWarning} from "./RecoveryBackup";
import {WalletBalances} from "./WalletBalances";
import {AccountName} from "./AccountName";
import {
  ACCOUNT_NAMES_EVENT,
  ACCOUNT_NAMES_KEY,
  ensureAccountNames,
  saveAccountName,
  savedAccountNames
} from "./account-names";
import {toast} from "sonner";
import {Button} from "@/components/ui/button";
import {CopyableField} from "@/components/CopyableField";
import {IndexedStore} from "@/storage/local-store";
import {VAULT_CHANGE_KEY, VAULT_EVENT, WalletVault} from "./vault";
import {OPEN_WALLET_MENU_EVENT} from "./wallet-menu-events";
import {unlockWallet} from "./managed-session";
import {canUsePasskeys, exportPasskeySecret, openPasskeySession, passkeyError} from "./passkey";
import {
  PASSKEY_ACCOUNTS_EVENT,
  PASSKEY_ACCOUNTS_KEY,
  rememberPasskeyAccount,
  type SavedPasskeyAccount,
  savedPasskeyAccounts
} from "./saved-passkeys";
import {useApproval} from "./ApprovalProvider";
import {useSession} from "./session-store";
import {useCommerceAccess} from "@/commerce/client";
import {useAdministrator} from "@/commerce/FeaturedAdmin";
import {reownProjectId} from "@/config/reown";
import metamaskLogo from "@/assets/metamask.svg";
import walletConnectLogo from "@/assets/walletconnect.svg";

const vault = new WalletVault(new IndexedStore());
type Mode = "unlock" | "create" | "import" | "export" | "password" | "remove" | "passkey";
const titles: Record<Mode, string> = {
  unlock: "Sign in",
  create: "Create password account",
  passkey: "Create account with passkey",
  import: "Import",
  export: "Back up account",
  password: "Change password",
  remove: "Remove wallet"
};
const actionIcons = {
  unlock: LockKeyhole,
  create: Plus,
  passkey: Plus,
  import: Upload,
  export: Eye,
  password: KeyRound,
  remove: Trash2
};
const short = (address: string) => `${address.slice(0, 8)}...${address.slice(-6)}`;

export function WalletMenu() {
  const wallet = useSession(), approve = useApproval();
  const access = useCommerceAccess();
  const admin = useAdministrator();
  const [address, setAddress] = useState<string | null>(null), [accounts, setAccounts] = useState<string[]>([]), [loading, setLoading] = useState(true);
  const [passkeyAccounts, setPasskeyAccounts] = useState(savedPasskeyAccounts);
  const [accountNames, setAccountNames] = useState(savedAccountNames);
  const [password, setPassword] = useState(""), [nextPassword, setNextPassword] = useState(""), [confirmation, setConfirmation] = useState("");
  const [importText, setImportText] = useState(""), [mode, setMode] = useState<Mode | null>(null), [target, setTarget] = useState<string | null>(null);
  const [importKind, setImportKind] = useState<"phrase" | "key">("phrase");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [backup, setBackup] = useState("");
  const [removeAddress, setRemoveAddress] = useState(""), [backedUp, setBackedUp] = useState(false), [label, setLabel] = useState("personal");

  const mounted = useRef(true), pending = useRef(false), dialog = useRef<HTMLDialogElement>(null), revision = useRef(0);
  const shownAddress = wallet.session?.address ?? address;
  const panel = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const location = useLocation(), navigate = useNavigate();

  function positionPanel() {
    if (!panel.current || !trigger.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const width = Math.min(wallet.session ? 700 : 420, window.innerWidth - 24);
    panel.current.style.width = width + "px";
    panel.current.style.left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)) + "px";
    const top = Math.min(rect.bottom + 10, window.innerHeight - 100);
    panel.current.style.top = top + "px";
    panel.current.style.maxHeight = Math.max(80, window.innerHeight - top - 12) + "px";
  }

  function showMenu() {
    positionPanel();
    panel.current?.showPopover();
  }

  useEffect(() => {
    if (!open) return;
    positionPanel();
    window.addEventListener("resize", positionPanel);
    window.addEventListener("scroll", positionPanel, true);
    return () => {
      window.removeEventListener("resize", positionPanel);
      window.removeEventListener("scroll", positionPanel, true);
    };
  }, [open, !!wallet.session]);
  useEffect(() => {
    const openRequested = () => showMenu();
    window.addEventListener(OPEN_WALLET_MENU_EVENT, openRequested);
    return () => window.removeEventListener(OPEN_WALLET_MENU_EVENT, openRequested);
  }, [wallet.session]);
  useEffect(() => {
    const query = new URLSearchParams(location.search);
    if (query.get("wallet") === "open") {
      showMenu();
      query.delete("wallet");
      navigate({pathname: location.pathname, search: query.toString()}, {replace: true});
    } else panel.current?.hidePopover();
  }, [location.pathname]);
  const blocked = busy || wallet.busy;
  const passkeyAvailable = canUsePasskeys();
  const passkeyExport = mode === "export" && !!wallet.session?.passkey;

  async function loadAccounts() {
    const [selected, list] = await Promise.all([vault.selected(), vault.list()]);
    if (mounted.current) {
      setAddress(selected);
      setAccounts(list);
      setLoading(false);
    }
  }

  function clearSecrets() {
    setBackup("");
    setPassword("");
    setNextPassword("");
    setConfirmation("");
    setImportText("");
  }

  function closeDialog() {
    revision.current++;
    setMode(null);
    clearSecrets();
    setError("");
  }

  useEffect(() => {
    mounted.current = true;
    void loadAccounts().catch(() => {
      setLoading(false);
      setError("Local wallet storage is unavailable.");
    });
    const refresh = () => {
      revision.current++;
      clearSecrets();
      void loadAccounts().catch(() => {
      });
    };
    const sync = (event: StorageEvent) => {
      if (event.key === VAULT_CHANGE_KEY || event.key === null) {
        closeDialog();
        refresh();
      }
    };
    const hide = () => closeDialog();
    window.addEventListener(VAULT_EVENT, refresh);
    window.addEventListener("storage", sync);
    window.addEventListener("pagehide", hide);
    return () => {
      mounted.current = false;
      revision.current++;
      window.removeEventListener(VAULT_EVENT, refresh);
      window.removeEventListener("storage", sync);
      window.removeEventListener("pagehide", hide);
    };
  }, []);
  useEffect(() => {
    closeDialog();
  }, [wallet.sessionEpoch]);
  useEffect(() => {
    const refresh = () => setPasskeyAccounts(savedPasskeyAccounts());
    const sync = (event: StorageEvent) => {
      if (event.key === PASSKEY_ACCOUNTS_KEY || event.key === null) refresh();
    };
    refresh();
    window.addEventListener(PASSKEY_ACCOUNTS_EVENT, refresh);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(PASSKEY_ACCOUNTS_EVENT, refresh);
      window.removeEventListener("storage", sync);
    };
  }, []);
  useEffect(() => {
    if (wallet.session?.passkey) rememberPasskeyAccount({address: wallet.session.address, ...wallet.session.passkey});
  }, [wallet.session]);
  useEffect(() => {
    if (!loading) setAccountNames(ensureAccountNames([...accounts, ...passkeyAccounts.map(account => account.address)]));
  }, [loading, accounts, passkeyAccounts]);
  useEffect(() => {
    const refresh = () => setAccountNames(savedAccountNames());
    const sync = (event: StorageEvent) => {
      if (event.key === ACCOUNT_NAMES_KEY || event.key === null) refresh();
    };
    window.addEventListener(ACCOUNT_NAMES_EVENT, refresh);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(ACCOUNT_NAMES_EVENT, refresh);
      window.removeEventListener("storage", sync);
    };
  }, []);
  useEffect(() => {
    if (mode) dialog.current?.showModal(); else dialog.current?.close();
  }, [mode]);
  useEffect(() => {
    if (!backup) return;
    const timer = setTimeout(() => setBackup(""), 60000);
    return () => clearTimeout(timer);
  }, [backup]);

  function openAction(value: Mode, account: string | null = shownAddress) {
    panel.current?.hidePopover();
    revision.current++;
    clearSecrets();
    setError("");
    setTarget(account);
    setMode(value);
    setImportKind("phrase");
    setBackedUp(false);
    setRemoveAddress("");
  }

  async function connectPasskey(action: "create" | "signin", selected?: SavedPasskeyAccount) {
    if (pending.current || wallet.busy || wallet.session) return;
    pending.current = true;
    setBusy(true);
    setError("");
    const started = revision.current;
    try {
      const session = await openPasskeySession(action, approve, selected);
      if (!mounted.current || started !== revision.current) {
        session.lock();
        return;
      }
      await wallet.connectBuiltIn(session);
      if (action === "create") toast.success("Passkey account created. Save a recovery backup from your account menu.");
    } catch (cause) {
      if (mounted.current && started === revision.current) setError(action === "signin" ? "Couldn’t sign in with a passkey. If you haven’t created an account yet, choose Create Account." : passkeyError(cause));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!mode || pending.current || wallet.busy) return;
    if (wallet.session && ["unlock", "create", "import"].includes(mode)) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setBackup("");
    const started = revision.current;
    try {
      if (["create", "import", "password"].includes(mode) && (mode === "password" ? nextPassword : password) !== confirmation) throw new Error("Passphrases do not match.");
      if (mode === "create" || mode === "import") {
        const input = importText.trim();
        if (mode === "import" && importKind === "key" && !/^(0x)?[\da-f]{64}$/i.test(input)) throw new Error("Enter a valid private key.");
        if (mode === "import" && importKind === "phrase" && ![12, 15, 18, 21, 24].includes(input.split(/\s+/).length)) throw new Error("Enter a valid recovery phrase.");
        const selected = mode === "create" ? await vault.create(password) : await vault.import(importKind === "key" && !input.startsWith("0x") ? `0x${input}` : input, password);
        if (mounted.current) {
          await loadAccounts();
          setAddress(selected);
          setTarget(selected);
          setMode("unlock");
          toast.success(mode === "create" ? "Account created. Back it up before adding funds." : "Account imported. Sign in to continue.");
        }
      } else {
        if (!target) throw new Error("Choose a saved wallet first.");
        if (mode === "unlock") {
          await vault.select(target);
          const session = await unlockWallet(vault, target, password, approve);
          if (!mounted.current) session.lock(); else await wallet.connectBuiltIn(session);
        } else if (mode === "export") {
          const secret = wallet.session?.passkey ? await exportPasskeySecret(wallet.session.passkey, target) : await vault.export(target, password);
          if (mounted.current && started === revision.current) setBackup(secret.mnemonic ? `Recovery phrase:\n${secret.mnemonic}\n\nPrivate key:\n${secret.privateKey}` : `Private key:\n${secret.privateKey}`);
          secret.privateKey = "";
          secret.mnemonic = null;
        } else if (mode === "password") {
          await vault.changePassword(target, password, nextPassword);
          toast.success("Local passphrase changed. Unlock with your new passphrase.");
          if (mounted.current) closeDialog();
        } else if (mode === "remove") {
          if (!backedUp || removeAddress.toLowerCase() !== target.toLowerCase()) throw new Error("Confirm your backup and enter the full wallet address.");
          await vault.remove(target, password);
          toast.success("Wallet removed from this browser.");
          if (mounted.current) {
            await loadAccounts();
            closeDialog();
          }
        }
      }
    } catch (cause) {
      if (mounted.current) setError(passkeyExport ? passkeyError(cause) : cause instanceof Error && /Passphrases|Confirm your backup|Choose a saved|Enter a valid/.test(cause.message) ? cause.message : "Could not complete this action. Check your passphrase and recovery input, then retry.");
    } finally {
      pending.current = false;
      if (mounted.current) {
        setPassword("");
        setNextPassword("");
        setConfirmation("");
        setImportText("");
        setBusy(false);
      }
    }
  }

  return <>
    <Button ref={trigger} icon={Wallet} variant="secondary" className="wallet-menu-trigger"
            aria-label={wallet.session ? "Account menu" : wallet.lastUsed ? `Sign in as ${short(wallet.lastUsed.address)}` : "Sign in"}
            aria-expanded={open} aria-controls="wallet-menu-panel" onClick={() => {
      if (open) panel.current?.hidePopover(); else showMenu();
    }}><span>{wallet.session ? short(wallet.session.address) : wallet.lastUsed ? short(wallet.lastUsed.address) : "Sign in"}</span></Button>
    <div ref={panel} id="wallet-menu-panel" popover="auto" className="wallet-popover" role="dialog" aria-label="Wallet"
         onToggle={event => setOpen(event.newState === "open")}>
      <div className="section-heading">
        <div><p
          className="eyebrow">{wallet.session ? (wallet.session.kind === "builtin" ? "BUILT-IN ACCOUNT" : "CONNECTED WALLET") : "GET STARTED"}</p>
          <h2>{wallet.session ? "Your account" : "Sign in existing account"}</h2></div>
        <div className="wallet-popover-header-actions">{wallet.session &&
            <span className="network">Monad Testnet</span>}<Button icon={X} variant="ghost" size="icon"
                                                                   title="Close wallet menu"
                                                                   aria-label="Close wallet menu"
                                                                   onClick={() => panel.current?.hidePopover()}/></div>
      </div>
      {!mode && (wallet.error || error) && <p role="alert">{error || wallet.error}</p>}{wallet.notice &&
        <p role="status">{wallet.notice}</p>}
      {wallet.session ? <div className="wallet-popover-connected">
        <section className="wallet-popover-info" aria-label="Wallet information">
          <div className="wallet-account-card">
            <CopyableField label="Address" value={wallet.session.address} displayValue={short(wallet.session.address)}/>
            <p className="wallet-status-label">Status</p><p
            className="wallet-account-status">{["0x279f", "10143"].includes(wallet.session.chainId ?? "") ? "Connected" : "Switch network to continue"}</p>
            <Button asChild variant="link"><a href={`https://testnet.monadvision.com/address/${wallet.session.address}`}
                                              target="_blank" rel="noopener noreferrer"><ExternalLink
              aria-hidden="true"/>View on explorer</a></Button>
          </div>
          <div className="wallet-account-navigation"><Button asChild variant="ghost"><Link to="/arbitration"
                                                                                           onClick={() => panel.current?.hidePopover()}><Scale
            aria-hidden="true"/>Arbitration</Link></Button><Button asChild variant="ghost"><Link to="/platform"
                                                                                                 onClick={() => panel.current?.hidePopover()}><SlidersHorizontal
            aria-hidden="true"/>Settings</Link></Button>{admin.isAdmin && !wallet.session.locked && <><Button asChild
                                                                                                              variant="ghost"><Link
              to="/admin/featured" onClick={() => panel.current?.hidePopover()}><Star aria-hidden="true"/>Top
              Offers</Link></Button><Button asChild variant="ghost"><Link to="/admin/restricted"
                                                                          onClick={() => panel.current?.hidePopover()}><ShieldCheck
              aria-hidden="true"/>Restricted Offers</Link></Button></>}</div>
        </section>
        <section className="wallet-popover-actions" aria-label="Wallet actions">
          <WalletBalances key={wallet.session.address} address={wallet.session.address}/>
          {wallet.session.kind === "builtin" && <><Button icon={ShieldCheck} variant="secondary" disabled={blocked}
                                                          onClick={() => openAction("export")}>Back up
              account</Button>{!wallet.session.passkey && <><Button icon={KeyRound} variant="secondary"
                                                                    disabled={blocked}
                                                                    onClick={() => openAction("password")}>Change
              password</Button><Button icon={Trash2} variant="secondary" className="wallet-remove-action"
                                       disabled={blocked} onClick={() => openAction("remove")}>Remove local
              wallet</Button></>}</>}
          {!["0x279f", "10143"].includes(wallet.session.chainId ?? "") &&
              <Button icon={Network} disabled={blocked} onClick={() => void wallet.switchNetwork()}>Switch to Monad
                  Testnet</Button>}
          <Button icon={wallet.session.kind === "builtin" ? LockKeyhole : LogOut} variant="destructive"
                  disabled={blocked} onClick={() => void access.signOut()}>Sign out</Button>
          <details className="wallet-advanced">
            <summary>Advanced</summary>
            <Button icon={Check} variant="secondary" disabled={wallet.busy}
                    onClick={() => void wallet.testCompatibility()}>Check signing compatibility</Button>
            <p>Compatibility: {wallet.compatibility}</p><label>Receiving identity label<input value={label}
                                                                                              onChange={e => setLabel(e.target.value)}/></label><Button
            icon={KeyRound} disabled={wallet.busy} onClick={() => void wallet.restoreIdentity(label)}>Restore receiving
            identity</Button>{wallet.identities.map(identity => <p className="wallet-address"
                                                                   key={identity.publicKey}>{identity.label}: {identity.publicKey}</p>)}
          </details>
        </section>
      </div> : <div className="wallet-popover-disconnected">
        <p className="muted">Already have a PayUnlock passkey? Sign in here.</p>
        <Button icon={KeyRound} disabled={blocked || !passkeyAvailable} loading={busy}
                onClick={() => void connectPasskey("signin")}>Sign in with passkey</Button>
        {!passkeyAvailable &&
            <p className="muted">Passkeys are unavailable in this browser. Use a saved password account or import your
                recovery backup.</p>}
        <section className="wallet-popover-saved">
          <div className="section-heading"><h3>Your accounts</h3>
            <span>{accounts.length + passkeyAccounts.length} saved</span></div>
          {loading ? <p role="status">Loading accounts...</p> : accounts.length + passkeyAccounts.length === 0 ?
            <p className="muted">No accounts saved in this browser yet.</p> :
            <div className="wallet-account-list">{accounts.map((value, index) => {
              const lastUsed = wallet.lastUsed?.kind === "password" && wallet.lastUsed.address.toLowerCase() === value.toLowerCase();
              return <article className={`wallet-account${lastUsed ? " last-used" : ""}`} key={value}>
                <div className="wallet-account-heading"><AccountName
                  name={accountNames[value.toLowerCase()] ?? `Account ${index + 1}`} disabled={blocked}
                  onSave={name => setAccountNames(saveAccountName(value, name))}/><span
                  className="muted"> &middot; Password</span>{lastUsed &&
                    <span className="wallet-last-used">Last used</span>}</div>
                <CopyableField hideLabel label="Address" value={value} displayValue={short(value)}/>
                <div className="actions"><Button icon={Trash2} variant="ghost" size="icon" title="Remove local wallet"
                                                 aria-label={"Remove wallet " + short(value)} disabled={blocked}
                                                 onClick={() => openAction("remove", value)}/><Button icon={LockKeyhole}
                                                                                                      disabled={blocked}
                                                                                                      onClick={() => openAction("unlock", value)}>{lastUsed ? "Unlock" : "Sign in"}</Button>
                </div>
              </article>;
            })}{passkeyAccounts.map((account, index) => {
              const lastUsed = wallet.lastUsed?.kind === "passkey" && wallet.lastUsed.address.toLowerCase() === account.address.toLowerCase() && wallet.lastUsed.credentialId === account.credentialId;
              return <article className={`wallet-account${lastUsed ? " last-used" : ""}`}
                              key={`passkey:${account.credentialId}`}>
                <div className="wallet-account-heading"><AccountName
                  name={accountNames[account.address.toLowerCase()] ?? `Account ${accounts.length + index + 1}`}
                  disabled={blocked} onSave={name => setAccountNames(saveAccountName(account.address, name))}/><span
                  className="muted"> &middot; Passkey</span>{lastUsed &&
                    <span className="wallet-last-used">Last used</span>}</div>
                <CopyableField hideLabel label="Address" value={account.address} displayValue={short(account.address)}/>
                <div className="actions"><Button icon={KeyRound} disabled={blocked || !passkeyAvailable}
                                                 aria-label={`${lastUsed ? "Unlock" : "Sign in to"} passkey account ${short(account.address)}`}
                                                 onClick={() => void connectPasskey("signin", account)}>{lastUsed ? "Unlock" : "Sign in"}</Button>
                </div>
              </article>;
            })}</div>}
        </section>
        <section className="wallet-popover-create">
          <div className="section-heading"><h2>Create Account</h2></div>
          <div className="actions"><Button icon={Plus} disabled={blocked}
                                           onClick={() => openAction(passkeyAvailable ? "passkey" : "create", null)}>Create
            Account</Button><Button icon={Upload} variant="secondary" disabled={blocked}
                                    onClick={() => openAction("import", null)}>Import</Button></div>
        </section>
        <section className="wallet-external-options"><h3>Or connect an existing wallet</h3>
          <div className="wallet-provider-buttons"><Button variant="secondary" disabled={blocked}
                                                           onClick={() => void wallet.connectMetaMask()}><img
            src={metamaskLogo} alt="" aria-hidden="true"/>Connect MetaMask</Button><Button variant="secondary"
                                                                                           disabled={blocked || !reownProjectId}
                                                                                           onClick={() => void wallet.connectWalletConnect()}><img
            src={walletConnectLogo} alt="" aria-hidden="true"/>Connect WalletConnect</Button></div>
          {!reownProjectId && <p className="muted">WalletConnect is unavailable in this environment.</p>}
        </section>
      </div>}
    </div>
    {createPortal(
      <dialog ref={dialog} className="approval-dialog wallet-action-dialog" aria-labelledby="wallet-action-title"
              onCancel={event => {
                event.preventDefault();
                if (!blocked) closeDialog();
              }}>
        {mode && <>
            <div className="section-heading"><h2 id="wallet-action-title">{titles[mode]}</h2><Button icon={X}
                                                                                                     variant="ghost"
                                                                                                     size="icon"
                                                                                                     aria-label="Close wallet dialog"
                                                                                                     title="Close"
                                                                                                     disabled={blocked}
                                                                                                     onClick={closeDialog}/>
            </div>
          {target && <p className="wallet-address">{target}</p>}
            <p className="muted">{mode === "passkey" ? "Create a new account using a passkey. To recover an existing account, cancel and choose Sign in with passkey. Save the passkey with a provider you can access on your other devices." : passkeyExport ? "Verify your passkey to export a recovery phrase and private key. Either can restore this same account using Import on a device without passkey support." : mode === "create" ? "Choose a password for your account on this browser. Keep a recovery backup to access it on another device." : mode === "import" ? "Restore an existing account using its recovery phrase or private key, then choose a password for this browser." : mode === "unlock" ? "Enter your password to sign in to this account." : mode === "password" ? "Change the password used on this browser. Your account and recovery backup stay the same." : mode === "export" ? "Your recovery material restores this wallet on another device. Keep it private." : "Remove this wallet from this browser."}</p>
          {mode === "export" && !backup && <RecoveryWarning/>}
          {mode === "passkey" &&
              <div className="dialog-actions"><Button icon={KeyRound} loading={busy} disabled={blocked}
                                                      onClick={() => void connectPasskey("create")}>Create
                  passkey</Button><Button variant="secondary" disabled={blocked}
                                          onClick={() => openAction("create", null)}>Use password instead</Button>
              </div>}
          {!backup && mode !== "passkey" && <form onSubmit={event => void submit(event)}>
              <fieldset disabled={blocked}>
                {mode === "import" && <>
                    <div className="actions" role="group" aria-label="Import method"><Button icon={KeyRound}
                                                                                             variant={importKind === "phrase" ? "default" : "secondary"}
                                                                                             aria-pressed={importKind === "phrase"}
                                                                                             onClick={() => {
                                                                                               setImportKind("phrase");
                                                                                               setImportText("");
                                                                                             }}>Recovery phrase</Button><Button
                        icon={KeyRound} variant={importKind === "key" ? "default" : "secondary"}
                        aria-pressed={importKind === "key"} onClick={() => {
                      setImportKind("key");
                      setImportText("");
                    }}>Private key</Button></div>
                    <label>{importKind === "phrase" ? "Recovery phrase" : "Private key"}<textarea autoComplete="off"
                                                                                                  spellCheck={false}
                                                                                                  required
                                                                                                  value={importText}
                                                                                                  onChange={e => setImportText(e.target.value)}/></label></>}
                {!passkeyExport && <label>{mode === "password" ? "Current password" : "Password"}<input type="password"
                                                                                                        autoComplete={["create", "import"].includes(mode) ? "new-password" : "current-password"}
                                                                                                        minLength={12}
                                                                                                        maxLength={1024}
                                                                                                        required
                                                                                                        value={password}
                                                                                                        onChange={e => setPassword(e.target.value)}/></label>}
                {mode === "password" &&
                    <label>New password<input type="password" autoComplete="new-password" minLength={12}
                                              maxLength={1024} required value={nextPassword}
                                              onChange={e => setNextPassword(e.target.value)}/></label>}
                {["create", "import", "password"].includes(mode) &&
                    <label>Confirm password<input type="password" autoComplete="new-password" minLength={12}
                                                  maxLength={1024} required value={confirmation}
                                                  onChange={e => setConfirmation(e.target.value)}/></label>}
                {mode === "remove" &&
                    <div className="danger-note"><p>Funds stay onchain. You need your recovery phrase or private key to
                        restore access. Protected order backups remain in this browser.</p><label
                        className="checkbox"><input type="checkbox" required checked={backedUp}
                                                    onChange={e => setBackedUp(e.target.checked)}/>I have saved my
                        recovery material.</label><label>Full wallet address to remove<input required
                                                                                             value={removeAddress}
                                                                                             onChange={e => setRemoveAddress(e.target.value)}
                                                                                             autoComplete="off"/></label>
                    </div>}
                  <div className="dialog-actions"><Button icon={X} variant="secondary"
                                                          onClick={closeDialog}>Cancel</Button><Button type="submit"
                                                                                                       icon={actionIcons[mode]}
                                                                                                       variant={mode === "remove" ? "destructive" : "default"}
                                                                                                       loading={busy}>{mode === "export" ? "Prepare recovery backup" : titles[mode]}</Button>
                  </div>
              </fieldset>
          </form>}
          {(error || wallet.error) && <p role="alert">{error || wallet.error}</p>}
          {backup && <RecoveryBackup backup={backup} onHide={() => setBackup("")}/>}</>}
      </dialog>, document.body)}
  </>;
}
