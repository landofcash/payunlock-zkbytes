import { BulkDeliverySession } from "./delivery-session";
import { X as ButtonX, Wallet as ButtonWallet, ArrowRight as ButtonArrowRight, Undo2 as ButtonUndo2, ArrowLeft as ButtonArrowLeft, ListChecks as ButtonListChecks, Eye as ButtonEye, Pause as ButtonPause, Download as ButtonDownload, Check as ButtonCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyableField } from "@/components/CopyableField";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, Check, Download, LockKeyhole, PackageCheck, RefreshCw, ShieldCheck } from "lucide-react";
import { formatEther, Transaction } from "ethers";
import { useSession } from "@/wallet/session-store";
import { type ReviewedTransaction } from "@/wallet/managed-session";
import { deliveryApproval, type DeliveryAuthorization } from "@/wallet/delivery-authorization";
import { useCommerce, useCommerceAccess, type Configuration, type OrderView, type Page, type PreparedTx, type Product } from "./client";
import { assignments, deliveryText, type BulkEntry, type BulkManifest, type ContentMode } from "./bulk-journal";
import { NotSubmitted, runBulkDelivery, runBulkRefunds, type BulkRuntime } from "./bulk-runner";
import { prepareDelivery, receivingMessage, type Order } from "./protocol";
import { deploymentIdentity, protocolOrder, reference, storageService } from "./lifecycle";

const states = ["Missing", "Ready to deliver", "Reserved", "Delivered", "Awaiting seller", "Awaiting buyer", "Arbitration", "Accepted", "Paid out", "Refunded"];
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
function download(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([typeof value === "string" ? value : JSON.stringify(value, null, 2)], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function Modal({ title, children, close }: { title: string; children: ReactNode; close?: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); return () => ref.current?.close(); }, []);
  return <dialog className="bulk-modal" ref={ref} aria-label={title} onCancel={e => { e.preventDefault(); close?.(); }}><h2>{title}</h2>{children}{close && <Button icon={ButtonX} className="secondary" onClick={close}>Close</Button>}</dialog>;
}
export function BulkDelivery() {
  const { id = "" } = useParams(), [, setQuery] = useSearchParams(), api = useCommerce(), access = useCommerceAccess(), wallet = useSession();
  const account = wallet.session?.address.toLowerCase(), live = useRef(true), running = useRef(false), stop = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [step, setStep] = useState(0), [stage, setStage] = useState("Ready"), [tab, setTab] = useState<"delivery" | "refund">("delivery");
  const [product, setProduct] = useState<Product>(), [config, setConfig] = useState<Configuration>(), [deployment, setDeployment] = useState<Order["deployment"]>();
  const [page, setPage] = useState<Page<OrderView>>({ items: [], nextCursor: null }), [cursors, setCursors] = useState<string[]>(["0"]), [filter, setFilter] = useState("all"), [selected, setSelected] = useState<Map<string, OrderView>>(new Map());
  const [mode, setMode] = useState<ContentMode>("shared"), [shared, setShared] = useState(""), [rows, setRows] = useState(""), [tickets, setTickets] = useState<Map<string, string>>(new Map()), [reviewed, setReviewed] = useState(false);
  const journal = useRef(new BulkDeliverySession()).current;
  const credential = () => "";
  const [manifest, setManifest] = useState<BulkManifest>(), [entries, setEntries] = useState<BulkEntry[]>([]), [hash, setHash] = useState("");
  const [services, setServices] = useState<{ id: number; label: string }[]>([]), [serviceId, setServiceId] = useState(1), [txPrompt, setTxPrompt] = useState<PreparedTx>(), [lastTx, setLastTx] = useState<PreparedTx>();
  const [impact, setImpact] = useState<OrderView[]>(), [cancelConfirmed, setCancelConfirmed] = useState(false);
  useEffect(() => { live.current = true; stop.current = false; return () => { live.current = false; stop.current = true; journal.clear(); }; }, []);
  const current = () => live.current && !stop.current;
  async function task(work: () => Promise<void>) {
    if (running.current) return; running.current = true; stop.current = false; setBusy(true); setError("");
    try { await work(); } catch (e) { if (live.current) setError(e instanceof Error ? e.message : "Could not complete this step. Resume the saved operation."); }
    finally { running.current = false; if (live.current) { setBusy(false); setTxPrompt(undefined); } }
  }
  async function loadPage(cursor = "0") { const result = await api.request<Page<OrderView>>(`/seller/products/${id}/orders?after=${cursor}&limit=10`); if (live.current) setPage(result); }
  async function initialize() {
    const d = deploymentIdentity(await api.read<Order["deployment"]>("/deployment"));
    const p = await api.request<Product>(`/seller/products/${id}`), c = await api.request<{ configuration: Configuration }>(`/seller/products/${id}/registration`);
    const s = await api.read<{ items: { id: number; label: string }[] }>("/storage-services");
    if (!current()) return; setDeployment(d); setProduct(p); setConfig(c.configuration); setServices(s.items); setServiceId(s.items[0]?.id ?? 1);
    await loadPage();
  }
  useEffect(() => { if (account) void task(initialize); }, [id, account]);
  let preview: BulkEntry[] = [], validation = "";
  try { if (deployment && selected.size) preview = assignments([...selected.values()].map(v => protocolOrder(v, deployment)), shared, mode, rows, tickets); }
  catch (e) { validation = (e as Error).message; }
  function changeSelection(view: OrderView, checked: boolean) {
    setSelected(previous => { const next = new Map(previous); if (checked) next.set(view.orderId, view); else next.delete(view.orderId); return next; });
    setTickets(previous => { if (previous.has(view.orderId)) return previous; const next = new Map(previous); next.set(view.orderId, crypto.randomUUID()); return next; }); setReviewed(false);
  }
  const edit = () => setReviewed(false);
  async function withLock(operation: BulkManifest, work: () => Promise<void>) {
    if (!navigator.locks) throw new Error("This browser cannot protect an operation across tabs. Use a current browser on HTTPS or localhost.");
    await navigator.locks.request(`payunlock-bulk:${operation.account}:${operation.deployment.contract}`, { ifAvailable: true }, async lock => { if (!lock) throw new Error("Another tab is running a seller operation. Pause it first."); await work(); });
  }
  async function create(kind: "delivery" | "refund") {
    if (!deployment || !config || !account) throw new Error("Connect your wallet and load the offer first.");
    if (kind === "delivery" && (!reviewed || validation || !preview.length)) throw new Error(validation || "Review the assigned content first.");
    const items: BulkEntry[] = kind === "delivery" ? preview : (impact ?? []).map(v => ({ order: protocolOrder(v, deployment), payload: { text: "", tickets: [] }, status: "draft" }));
    const op: BulkManifest = { version: 1, kind, id: crypto.randomUUID(), account, deployment, productId: id, productKey: config.productKey, orderIds: items.map(e => e.order.orderId), createdAt: new Date().toISOString(), mode, storageServiceId: serviceId, transactions: [], complete: false };
    journal.clear();
    await withLock(op, async () => { setStage("Prepare delivery"); await journal.create(op, items, credential(), current); });
    if (!current()) return;
    setManifest(op); setEntries(items); setQuery({ operation: op.id }); setStep(2); setStage("Ready to send");
    setShared(""); setRows(""); setSelected(new Map()); setTickets(new Map());

  }
  async function execute(cancelOnly = false) {
    if (!manifest || !wallet.session || !deployment) throw new Error("Unlock the delivery session first.");
    await withLock(manifest, async () => {
      const op = await journal.load(manifest.id, credential()); setManifest(op);
      if (op.account !== wallet.session!.address.toLowerCase()) throw new Error("Wrong wallet.");
      const protectedEntries = await Promise.all(op.orderIds.map(orderId => journal.entry(op.id, orderId, credential())));
      let revoke: (() => void) | undefined;
      const scope: DeliveryAuthorization = { contract: op.deployment.contract, messages: [...new Set(protectedEntries.map(e => receivingMessage(e.order.seller.context)))], commitments: {}, references: {} };
      function authorize(items: BulkEntry[]) {
        for (const e of items) if (e.prepared) { scope.commitments[e.order.orderId] = e.prepared.recordHash; scope.references[e.order.orderId] = reference(e.prepared.record); }
        revoke?.(); if (op.kind === "delivery") revoke = wallet.session?.authorizeDelivery?.(scope);
      }
      authorize(protectedEntries);
      const runtime: BulkRuntime = {
        api, journal, password: credential(), current,
        update(label, items, tx) { if (current()) { authorize(items); setStage(label); setEntries(items.map(e => ({ ...e }))); if (tx) setLastTx(tx); } },
        async prepare(entry, view) {
          const service = storageService(await api.read(`/storage-service?id=${op.storageServiceId ?? serviceId}&prepare=true`));
          return wallet.runOfferKeysOperation(entry.order.seller.context, entry.order.seller.publicKey, (keys, session, valid) => prepareDelivery({ order: entry.order, payload: entry.payload, signer: session, service, latestPublicationSeconds: view.order.state === 2 ? BigInt(view.order.publicationDeadline) : BigInt(Math.max(view.block.timestamp, Math.floor(Date.now() / 1000))) + BigInt(view.order.terms.commitmentWindow), offerKeys: keys, isCurrent: () => valid() && current() }));
        },
        async send(tx, action, remember) {
          try {
            if (!current()) throw new Error("Paused before signing.");
            const fresh = await api.request<PreparedTx>("/transactions/prepare", action);
            if (fresh.to !== tx.to || fresh.data !== tx.data || fresh.value !== tx.value || fresh.nonce !== tx.nonce || BigInt(fresh.gas) > BigInt(tx.gas) || BigInt(fresh.maxFeePerGas) > BigInt(tx.maxFeePerGas)) throw new Error("Gas or transaction details changed. Resume to prepare a fresh batch.");
          } catch (e) { throw new NotSubmitted((e as Error).message); }
          await wallet.runOperation(async (session, valid) => {
            if (!valid() || !current() || session.address.toLowerCase() !== op.account) throw new NotSubmitted("Wallet changed before signing.");
            const reviewedTx: ReviewedTransaction = { chainId: 10143, to: tx.to as `0x${string}`, data: tx.data as `0x${string}`, value: BigInt(tx.value), gas: BigInt(tx.gas), nonce: tx.nonce, maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) };
            if (op.kind === "delivery" && !await deliveryApproval(scope)({ kind: "transaction", transaction: reviewedTx })) throw new NotSubmitted("Transaction does not match the reviewed deliveries.");
            if (session.kind !== "builtin") setTxPrompt(tx);
            try {
              if (session.signTransaction) {
                let raw: string;
                try { raw = await session.signTransaction(reviewedTx); } catch (e) { throw new NotSubmitted((e as Error).message); }
                const hash = Transaction.from(raw).hash!; await remember(hash, raw);
                if (!valid() || !current()) throw new Error("Signed transaction saved. Resume to check it.");
                await api.request("/transactions/broadcast", { action, raw });
              } else if (session.sendTransaction) await remember(await session.sendTransaction(reviewedTx));
              else throw new NotSubmitted("This wallet cannot send transactions.");
            } finally { if (live.current) setTxPrompt(undefined); }
          }, { action: "sign", label: "Delivery transaction" });
          if (current()) setStage("Waiting for successful finality");
        },
      };
      try { const result = op.kind === "delivery" ? await runBulkDelivery(runtime, op) : await runBulkRefunds(runtime, op, cancelOnly); if (current()) { setEntries(result); setManifest({ ...op }); if (op.complete) journal.clear(); } }
      finally { revoke?.(); }
    });
  }
  async function loadImpact() {
    const result = new Map<string, OrderView>(); let after: string | null = "0";
    do { if (!current()) return; const next: Page<OrderView> = await api.request(`/seller/products/${id}/orders?after=${after}&limit=30`); next.items.forEach(v => result.set(v.orderId, v)); after = next.nextCursor; } while (after);
    setImpact([...result.values()]); setCancelConfirmed(false);
  }
  async function attachHash() {
    if (!manifest || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("Enter the existing transaction hash.");
    await withLock(manifest, async () => {
      const op = await journal.load(manifest.id, credential()), pending = op.transactions.find(t => ["checking", "signing"].includes(t.status));
      if (!pending) throw new Error("No uncertain transaction needs a hash.");
      const result = await api.request<{ status: string }>("/transactions/batch-status", { hash, action: pending.action });
      if (result.status === "uncertain") throw new Error("This transaction is not visible yet. Keep the existing operation and check again.");
      pending.hash = hash; await journal.save(op, credential()); setManifest(op); setHash("");
    });
  }
  const display = manifest ? entries : preview, externalSignature = wallet.session?.kind !== "builtin" && wallet.walletActivity?.phase === "approval";
  const executionStep = manifest?.complete ? 8 : stage.includes("finality") ? 5 : /publication|Verifying/.test(stage) ? 6 : /reservation|Reservation/.test(stage) ? 4 : /upload/.test(stage) ? 3 : /keys/.test(stage) ? 2 : 2;
  const eligible = (v: OrderView) => !v.canceled && (v.order.state === 1 || (v.order.state === 2 && BigInt(v.order.publicationDeadline) > BigInt(v.block.timestamp)));
  const visible = page.items.filter(v => filter === "all" || eligible(v));
  return <section className="bulk-workspace">
    <Button asChild variant="ghost"><Link to={`/sales/products/${id}`}><ArrowLeft aria-hidden="true" />Manage offer</Link></Button>
    <div className="bulk-heading"><div><p className="eyebrow">SELLER WORKSPACE</p><h1>{product?.title ?? "Offer fulfillment"}</h1><p>Prepare private deliveries. Keep every buyer’s content in the right hands.</p></div><span className="bulk-pill"><ShieldCheck size={16} /> Encrypted delivery</span></div>
    {!account ? <div className="bulk-panel"><h2>Sign in as seller</h2><p>Unlock the seller wallet to check orders and continue delivery.</p><Button onClick={() => access.unlock()}><ButtonWallet size={16} /> Sign in</Button></div> : <>
    <div className="bulk-tabs" role="group" aria-label="Seller workflow"><Button icon={ButtonArrowRight} className={tab === "delivery" ? "active" : ""} disabled={busy || !!manifest} onClick={() => setTab("delivery")}>Deliver orders</Button><Button icon={ButtonUndo2} className={tab === "refund" ? "active" : ""} disabled={busy || !!manifest} onClick={() => setTab("refund")}>Cancel & refund</Button></div>
    {tab === "delivery" && <ol className="bulk-stepper">{["Select orders", "Prepare & review", "Deliver"].map((label, i) => <li key={label} className={i === step ? "active" : i < step ? "done" : ""} aria-current={i === step ? "step" : undefined}><span>{i < step ? <Check size={16} /> : i + 1}</span>{label}</li>)}</ol>}
    {!manifest && tab === "delivery" && step === 0 && <div className="bulk-panel"><div className="bulk-toolbar"><div><h2>Choose orders</h2><p>{selected.size} selected across all pages</p></div><label>Show<select value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All orders</option><option value="eligible">Ready to deliver</option></select></label><Button icon={RefreshCw} iconSpinning={busy} className="secondary" disabled={busy} onClick={() => void task(() => loadPage(cursors.at(-1)))}>Refresh</Button></div>
      <p className="bulk-note">Order status is checked onchain. Newly purchased orders may take a moment to appear in history.</p>
      <div className="bulk-table-wrap"><table className="bulk-table"><thead><tr><th><input type="checkbox" aria-label="Select eligible orders on this page" disabled={busy || !visible.some(eligible)} checked={visible.some(eligible) && visible.filter(eligible).every(v => selected.has(v.orderId))} onChange={e => visible.filter(eligible).forEach(v => changeSelection(v, e.target.checked))} /></th><th>Order</th><th>Buyer</th><th>Status</th></tr></thead><tbody>{visible.map(v => <tr key={v.orderId}><td><input type="checkbox" aria-label={`Select order ${v.orderId}`} checked={selected.has(v.orderId)} disabled={busy || !eligible(v)} onChange={e => changeSelection(v, e.target.checked)} /></td><td><Link to={`/sales/orders/${v.orderId}`}>#{v.orderId}</Link></td><td className="buyer-wallet-cell"><CopyableField label="Buyer wallet" value={v.order.buyer} /></td><td><span className={`bulk-status ${eligible(v) ? "ready" : ""}`}>{v.canceled && v.order.state < 3 ? "Refund available" : states[v.order.state]}</span></td></tr>)}</tbody></table>{!visible.length && <p className="bulk-empty">No orders on this page.</p>}</div>
      <div className="bulk-toolbar"><Button icon={ButtonArrowLeft} className="secondary" disabled={busy || cursors.length === 1} onClick={() => void task(async () => { const next = cursors.slice(0, -1); await loadPage(next.at(-1)); setCursors(next); })}>Previous</Button><span>Page {cursors.length}</span><Button icon={ButtonArrowRight} className="secondary" disabled={busy || !page.nextCursor} onClick={() => void task(async () => { const next = page.nextCursor!; await loadPage(next); setCursors([...cursors, next]); })}>Next</Button><Button icon={ButtonListChecks} className="secondary" disabled={busy || !selected.size} onClick={() => { setSelected(new Map()); setReviewed(false); }}>Clear selection</Button><Button disabled={busy || !selected.size} onClick={() => setStep(1)}>Prepare {selected.size} orders <ArrowRight size={16} /></Button></div>
    </div>}
    {!manifest && tab === "delivery" && step === 1 && <div className="bulk-compose"><div className="bulk-panel"><h2>Prepare & review content</h2><p>Shared text appears in every delivery. Add one individual row or a unique ticket if needed.</p><label>Shared content<textarea rows={7} value={shared} onChange={e => { setShared(e.target.value); edit(); }} placeholder="A message, access instructions, or a private link…" /></label><fieldset><legend>Per-order content</legend>{(["shared", "rows", "tickets"] as const).map(value => <label className="bulk-choice" key={value}><input type="radio" name="content-mode" checked={mode === value} onChange={() => { setMode(value); edit(); }} />{value === "shared" ? "Shared content only" : value === "rows" ? "Individual pasted rows" : "Unique tickets"}</label>)}</fieldset>{mode === "rows" && <label>One row per selected order<textarea rows={7} value={rows} onChange={e => { setRows(e.target.value); edit(); }} placeholder="Paste plain text or tab-separated rows" /><small>Exactly {selected.size} non-empty rows, in the selected order shown in the previews. Tabs are retained; blank rows are rejected.</small></label>}{mode === "tickets" && <p className="bulk-note">One unique ticket per order. Tickets stay assigned when you change modes or resume this operation.</p>}<label>Storage service<select value={serviceId} onChange={e => { setServiceId(Number(e.target.value)); edit(); }}>{services.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label><Button className="secondary" onClick={() => { setStep(0); setReviewed(false); }}><ArrowLeft size={16} /> Change selection</Button></div>
      <div className="bulk-panel"><div className="bulk-toolbar"><h2>Buyer previews</h2><Button className="secondary" disabled={!preview.length || !!validation} onClick={() => download("deliveries.json", preview.map(e => ({ orderId: e.order.orderId, buyer: e.order.buyer.context.account, content: deliveryText(e), tickets: e.payload.tickets })))}><Download size={16} /> Export deliveries</Button></div><p>This is the complete readable content that will be encrypted separately for each order.</p>{validation && <p role="alert" className="bulk-error">{validation}</p>}<div className="bulk-previews">{display.map((e, i) => <details className="bulk-preview" key={e.order.orderId} open={i === 0 ? true : undefined}><summary>Order #{e.order.orderId} <span>{short(e.order.buyer.context.account)}</span></summary><pre>{deliveryText(e)}</pre></details>)}</div>
        <label className="bulk-choice"><input type="checkbox" checked={reviewed} disabled={!!validation || !preview.length} onChange={e => setReviewed(e.target.checked)} />I reviewed the assignments and content.</label><Button disabled={busy || !reviewed || !!validation} onClick={() => void task(() => create("delivery"))}><LockKeyhole size={16} /> Continue to delivery</Button></div></div>}
    {!manifest && tab === "refund" && <div className="bulk-panel"><h2>Cancel this offer</h2><p>Cancellation permanently stops new purchases. Paid orders and unpublished reservations become refundable. Published deliveries keep their review, dispute, arbitration and settlement rights.</p><Button icon={ButtonEye} className="secondary" disabled={busy} onClick={() => void task(loadImpact)}>Preview cancellation impact</Button>{impact && <><div className="bulk-stats"><div><strong>{impact.filter(v => [1, 2].includes(v.order.state)).length}</strong>Refundable after cancellation</div><div><strong>{impact.filter(v => v.order.state >= 3 && v.order.state !== 9).length}</strong>Published orders preserved</div><div><strong>{impact.filter(v => v.order.state === 9).length}</strong>Already refunded</div></div><p>Preview covers currently indexed orders. Refresh after cancellation to find any purchases that arrived while history was syncing.</p><label className="bulk-choice"><input type="checkbox" checked={cancelConfirmed} onChange={e => setCancelConfirmed(e.target.checked)} />I understand cancellation is permanent. Refunds are a separate step.</label><Button icon={ButtonUndo2} disabled={busy || !cancelConfirmed} onClick={() => void task(() => create("refund"))}>Save cancellation & refund operation</Button></>}</div>}
    {manifest && <div className="bulk-panel"><div className="bulk-toolbar"><div><p className="eyebrow">{manifest.kind === "delivery" ? "DELIVERY" : "CANCELLATION & REFUNDS"}</p><h2 role="status">{stage}</h2></div><span className="bulk-pill">{entries.filter(e => e.status === "published").length} / {entries.length} complete</span></div>
      <p>{wallet.session?.kind === "builtin" && manifest.kind === "delivery" ? "The built-in wallet signs this reviewed delivery automatically while unlocked. Its five-minute session is unchanged." : "Your wallet asks you to approve each transaction. Delivery also needs one offer-key signature per unlocked offer context."}</p>
      {manifest.kind === "delivery" && <ol className="bulk-execution">{["Protect draft", "Connect / unlock wallet", "Restore offer keys", "Encrypt, save & upload", "TX1 · Reserve deliveries", "Wait for successful finality", "TX2 · Publish deliveries", "Verify completion"].map((label, i) => <li key={label} className={i < executionStep ? "done" : i === executionStep ? "active" : ""} aria-current={i === executionStep ? "step" : undefined}><span>{i < executionStep ? <Check size={14} /> : i + 1}</span>{label}{[2, 4, 6].includes(i) && <small>{wallet.session?.kind === "builtin" ? "Automatic while unlocked" : "Wallet"}</small>}</li>)}</ol>}
      {lastTx && <p className="bulk-note">Last batch maximum gas cost: {formatEther(BigInt(lastTx.gas) * BigInt(lastTx.maxFeePerGas))} MON. Larger selections may require multiple batches.</p>}
      <div className="bulk-toolbar">{manifest.kind === "refund" && <Button icon={ButtonArrowRight} disabled={busy} onClick={() => void task(() => execute(true))}>1. Cancel offer</Button>}<Button disabled={busy || manifest.complete} onClick={() => void task(() => execute())}><PackageCheck size={16} />{manifest.kind === "delivery" ? "Start / resume delivery" : "2. Start / resume refunds"}</Button>{busy && <Button icon={ButtonPause} className="secondary" onClick={() => { stop.current = true; setStage("Pausing after the current request"); }}>Pause</Button>}<Button icon={ButtonDownload} className="secondary" disabled={busy || entries.every(e => e.status === "published")} onClick={() => download("deliveries.json", entries.filter(e => e.status !== "published").map(e => ({ orderId: e.order.orderId, buyer: e.order.buyer.context.account, content: deliveryText(e), tickets: e.payload.tickets })))}>Export pending deliveries</Button><Button icon={ButtonArrowLeft} className="secondary" disabled={busy} onClick={() => { journal.clear();  setManifest(undefined); setEntries([]); setStep(0); setQuery({}); void task(initialize); }}>Back to orders</Button></div>
      <div className="bulk-table-wrap"><table className="bulk-table"><thead><tr><th>Order</th><th>Buyer</th><th>Progress</th><th>Publication deadline</th></tr></thead><tbody>{entries.map(e => <tr key={e.order.orderId}><td><Link to={`/sales/orders/${e.order.orderId}`}>#{e.order.orderId}</Link></td><td className="buyer-wallet-cell"><CopyableField label="Buyer wallet" value={e.order.buyer.context.account} /></td><td><span className={`bulk-status ${e.status === "published" ? "ready" : ""}`}>{manifest.kind === "refund" && e.status === "published" ? "refunded" : e.status}</span>{e.error && <small>{e.error}</small>}</td><td>{e.deadline ? new Date(Number(e.deadline) * 1000).toLocaleString() : "—"}</td></tr>)}</tbody></table></div>
      {manifest.transactions.some(t => ["signing", "checking"].includes(t.status)) && <div className="bulk-note"><p>A saved transaction needs checking. Resume checks it without sending a replacement. If the wallet omitted its hash, copy that transaction’s hash here.</p><label>Existing transaction hash<input value={hash} onChange={e => setHash(e.target.value)} /></label><Button icon={ButtonCheck} disabled={busy} onClick={() => void task(attachHash)}>Verify & attach hash</Button></div>}
    </div>}

    </>}
    {error && <div className="bulk-error" role="alert">{error}</div>}
    {(txPrompt || externalSignature) && <Modal title={txPrompt ? "Approve transaction in your wallet" : "Sign message in your wallet"}><p>{txPrompt ? "Check the batch transaction in your wallet. After approval, PayUnlock waits for finality before continuing." : wallet.walletActivity?.label === "Offer delivery keys" ? "Restore your offer’s encryption keys. This signature is reused for the offer during this unlocked session and costs no gas." : "Sign in to PayUnlock. This signature costs no gas and does not transfer funds."}</p>{txPrompt && <><p>Maximum gas cost: {formatEther(BigInt(txPrompt.gas) * BigInt(txPrompt.maxFeePerGas))} MON</p><p className="address">Contract: {txPrompt.to}</p></>}<p>You can reject the request in your wallet. Your prepared content stays available while this page remains open.</p></Modal>}
  </section>;
}
