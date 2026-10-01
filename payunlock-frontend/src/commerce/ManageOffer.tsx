import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, ArrowRight, Check, CheckCircle2, Globe, Link as LinkIcon, Package, Pause, Pencil, Play, Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCommerce, type Product, type RegistrationConfiguration, type DraftTerms } from "./client";
import { useSession } from "@/wallet/session-store";
import { OfferFields } from "./OfferFields";
import { OfferReview } from "./OfferReview";
import { Feedback, journal, prepareOperation, randomId, TransactionPanel, useTask } from "./ui";
import type { Operation } from "./purchase-journal";
import { OrderDialog } from "./OrderPresentation";

export function confirmedOfferTerms(configuration: RegistrationConfiguration): DraftTerms {
  const terms = configuration.productTerms;
  return terms ? { token: terms.token, price: terms.price, eventEnd: terms.hasEventEnd ? terms.eventEnd : null, reviewWindow: terms.hasReviewOverride ? terms.reviewOverride : null, commitmentWindow: Number(terms.commitmentWindow) } : { token: configuration.terms.token, price: configuration.terms.price, eventEnd: configuration.terms.hasEventEnd ? configuration.terms.eventEnd : null, reviewWindow: configuration.terms.reviewWindow, commitmentWindow: Number(configuration.terms.commitmentWindow) };
}
function sameTerms(a: DraftTerms, b: DraftTerms) { return a.token.toLowerCase() === b.token.toLowerCase() && a.price === b.price && a.eventEnd === b.eventEnd && a.reviewWindow === b.reviewWindow && a.commitmentWindow === b.commitmentWindow; }

export function ManageOffer({ initialProduct, configuration, operation, defaultReview, bounds }: { initialProduct: Product; configuration: RegistrationConfiguration; operation?: Operation; defaultReview?: string; bounds?: { minCommitmentWindow: number; maxCommitmentWindow: number } }) {
  const api = useCommerce(), wallet = useSession(), task = useTask();
  const [product, setProduct] = useState(initialProduct), [confirmed, setConfirmed] = useState(configuration);
  const [form, setForm] = useState<Omit<Product, "id" | "revision">>(initialProduct), [valid, setValid] = useState(false);
  const [record, setRecord] = useState(operation);
  const [history, setHistory] = useState<Operation[]>([]);
  useEffect(() => { let live = true; void journal.list(wallet.session!.address).then(rows => { if (live) setHistory(rows.filter(row => row.productId === product.id && row.deployment.contract.toLowerCase() === confirmed.contract.toLowerCase() && row.progress === "finalized").reverse()); }).catch(() => {}); return () => { live = false; }; }, [product.id, record?.version]);
  const [mode, setMode] = useState<"overview" | "edit" | "review" | "transaction" | "result">(operation && ["review", "checking", "reverted"].includes(operation.progress) ? "transaction" : "overview");
  const [visibility, setVisibility] = useState(initialProduct.visibility === "public" ? "public" as const : "hidden" as const);
  const [salesDialog, setSalesDialog] = useState(false), [result, setResult] = useState("");
  const [transactionReviewOpen, setTransactionReviewOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (salesDialog) dialog.current?.showModal(); else dialog.current?.close(); }, [salesDialog]);
  const currentTerms = confirmedOfferTerms(confirmed);
  const current = { ...product, draftTerms: currentTerms };
  const changedTerms = !!form.draftTerms && !sameTerms(form.draftTerms, currentTerms);
  const stagedTerms = !!product.draftTerms && !sameTerms(product.draftTerms, currentTerms);
  const changed = changedTerms || form.title !== product.title || form.description !== product.description || JSON.stringify(form.images ?? []) !== JSON.stringify(product.images ?? []);
  const pending = record?.progress === "checking";
  async function persist(next: Omit<Product, "id" | "revision">) {
    const saved = await api.request<Product>(`/seller/products/${product.id}`, { title: next.title, description: next.description, images: next.images, visibility: next.visibility, draftTerms: next.draftTerms, expectedRevision: product.revision }, "PUT");
    setProduct(saved); setForm(saved); return saved;
  }
  async function prepare(kind: "update" | "disable") {
    if (pending) throw new Error("Wait for the pending transaction before making changes.");
    const deployment = await api.read<{ chainId: 10143; contract: string }>("/deployment");
    if (deployment.contract.toLowerCase() !== confirmed.contract.toLowerCase()) throw new Error("Deployment changed. Reload this offer.");
    let next = record && record.progress !== "finalized" ? { ...record, publication: undefined } : await journal.save({ id: randomId(), account: wallet.session!.address.toLowerCase(), deployment, productId: product.id, receiving: confirmed.sellerReceiving, hashes: [], progress: "draft", version: 0 });
    // Persist intent before preparation; saved terms can be resumed if preparation fails.
    setRecord(next);
    next = await prepareOperation(api, next, kind === "disable" ? { kind, productId: product.id, disabled: confirmed.status === 1 } : { kind, productId: product.id, receiving: confirmed.sellerReceiving });
    setRecord(next); setMode("transaction"); setSalesDialog(false); setTransactionReviewOpen(true);
  }
  async function applyChanges() {
    if (!changed || !valid) return;
    if (changedTerms) {
      const limits = await api.read<{ minCommitmentWindow: number; maxCommitmentWindow: number }>("/platform");
      if (form.draftTerms!.commitmentWindow < limits.minCommitmentWindow || form.draftTerms!.commitmentWindow > limits.maxCommitmentWindow) throw new Error("Publication bounds changed. Review the timing before continuing.");
    }
    await persist(form);
    if (changedTerms) await prepare("update");
    else { setResult("Offer details saved"); setMode("result"); }
  }
  async function finalized() {
    const response = await api.request<{ configuration: RegistrationConfiguration }>(`/seller/products/${product.id}/registration`);
    setConfirmed(response.configuration); setResult(record?.action?.kind === "disable" ? response.configuration.status === 1 ? "Sales resumed" : "Sales paused" : "Offer updated"); setMode("result");
  }
  function edit() { setForm({ ...product, draftTerms: stagedTerms ? product.draftTerms : currentTerms }); setMode("edit"); }
  return <section className="commerce-page manage-offer"><Button asChild variant="ghost"><Link to="/offers"><ArrowLeft aria-hidden="true" />Back to offers</Link></Button><h1>Manage offer</h1>
    {mode === "overview" && <>
      <section className="card offer-review"><div className="offer-statuses"><span>{product.visibility === "public" ? <Globe size={15} /> : <LinkIcon size={15} />}{product.visibility === "public" ? "Public" : "Private"}</span><span>{confirmed.status === 1 ? <Play size={15} /> : <Pause size={15} />}{confirmed.status === 1 ? "Sales active" : "Sales paused"}</span></div><OfferReview product={current} defaultReview={confirmed.terms.reviewWindow} />
        {stagedTerms && <p role="status">Saved changes have not been applied yet. Edit the offer to review and apply them.</p>}
        <div className="offer-review-actions"><Button icon={Pencil} onClick={edit}>Edit offer</Button><div className="actions"><Button asChild variant="secondary"><Link to={`/sales/products/${product.id}/orders`}><Package />View orders</Link></Button><Button asChild variant="secondary"><Link to={`/products/${product.id}`}><LinkIcon />Open offer</Link></Button></div></div>
      </section>
      <div className="offer-management-controls"><section className="card"><h2>Visibility</h2><p className="muted">Public offers appear in Discover. Private offers are available through a direct link.</p><div className="actions"><div className="offer-visibility-group" role="group" aria-label="Offer visibility">{(["hidden", "public"] as const).map(value => <Button key={value} icon={value === "hidden" ? LinkIcon : Globe} aria-pressed={visibility === value} variant={visibility === value ? "default" : "secondary"} disabled={task.busy} onClick={() => setVisibility(value)}>{value === "hidden" ? "Private" : "Public"}</Button>)}</div><Button icon={Save} disabled={task.busy || visibility === product.visibility} onClick={() => void task.run(async () => { await persist({ ...product, visibility }); setResult("Visibility updated"); })}>Save visibility</Button></div>{result === "Visibility updated" && <p role="status">Visibility updated</p>}</section>
      <section className="card"><h2>Sales</h2><p className="muted">{confirmed.status === 1 ? "Buyers can purchase this offer. Pausing sales stops new purchases; existing orders remain unchanged." : "New purchases are paused. Existing orders can still be fulfilled."}</p><Button icon={confirmed.status === 1 ? Pause : Play} variant="secondary" disabled={task.busy} onClick={() => setSalesDialog(true)}>{confirmed.status === 1 ? "Pause sales" : "Resume sales"}</Button></section></div>
      {record && record.progress !== "finalized" && record.progress !== "draft" && <section className="card"><h2>Unfinished transaction</h2><p>Review or check this transaction before starting another change.</p><Button icon={ArrowRight} onClick={() => setMode("transaction")}>Continue transaction</Button></section>}{history.length > 0 && <details className="card offer-transaction-history"><summary>Transaction history</summary>{history.map(item => <TransactionPanel key={item.id} record={item} onChange={() => {}} />)}</details>}
    </>}
    {mode === "edit" && <form className="offer-editor-form" onSubmit={event => { event.preventDefault(); if (valid && changed) setMode("review"); }}><OfferFields form={form} onChange={setForm} account={wallet.session!.address} confirmed={false} defaultReview={defaultReview} bounds={bounds} onValidity={setValid} /><div className="offer-review-actions"><Button icon={X} variant="secondary" onClick={() => setMode("overview")}>Cancel</Button><Button icon={ArrowRight} type="submit" disabled={!valid || !changed}>Review changes</Button></div></form>}
    {mode === "review" && <section className="card"><h2>Review changes</h2><div className="offer-change-comparison"><section><h3>Current offer</h3><OfferReview product={current} defaultReview={confirmed.terms.reviewWindow} /></section><section><h3>After changes</h3><OfferReview product={{ ...product, ...form }} defaultReview={defaultReview} /></section></div><p>{changedTerms ? "Price or timing changes require a transaction. You will review it before confirming. Existing orders keep their purchased terms." : "These changes do not require a transaction."}</p><div className="offer-review-actions"><Button icon={Pencil} variant="secondary" disabled={task.busy} onClick={() => setMode("edit")}>Back to editing</Button><Button icon={changedTerms ? ArrowRight : Save} disabled={task.busy} onClick={() => void task.run(applyChanges)}>{changedTerms ? "Review transaction" : "Save changes"}</Button></div></section>}
    {mode === "transaction" && record && <section className="card"><h2>{record.action?.kind === "disable" ? record.action.disabled ? "Pause sales" : "Resume sales" : "Update offer"}</h2><p>{pending ? "Transaction confirmation is pending." : record.progress === "reverted" ? "The transaction failed. Review it to try again." : "Review the transaction before confirming."}</p><Button icon={ArrowRight} onClick={() => setTransactionReviewOpen(true)}>{pending ? "Check transaction status" : "Review transaction"}</Button>{record.progress === "finalized" && <Button icon={Check} disabled={task.busy} onClick={() => void task.run(finalized)}>Refresh result</Button>}{!pending && <Button icon={ArrowLeft} variant="secondary" onClick={() => { setMode("overview"); }}>Back to offer</Button>}</section>}
    {mode === "result" && <section className="card"><CheckCircle2 className="publication-success-icon" /><h2>{result}</h2><p>Your offer now reflects the confirmed changes.</p><div className="actions"><Button icon={ArrowLeft} onClick={() => setMode("overview")}>Back to offer</Button><Button asChild variant="secondary"><Link to="/offers"><ArrowLeft />Back to offers</Link></Button></div></section>}
    <dialog ref={dialog} className="approval-dialog wallet-action-dialog" aria-labelledby="offer-sales-title" onCancel={event => { event.preventDefault(); setSalesDialog(false); }}><h2 id="offer-sales-title">{confirmed.status === 1 ? "Pause sales?" : "Resume sales?"}</h2><p>{confirmed.status === 1 ? "New purchases will stop. Existing orders and your offer visibility stay unchanged." : "Buyers will be able to purchase this offer again."} You will review a transaction before confirming.</p><div className="dialog-actions"><Button icon={X} variant="secondary" disabled={task.busy} onClick={() => setSalesDialog(false)}>Cancel</Button><Button icon={ArrowRight} disabled={task.busy} onClick={() => void task.run(() => prepare("disable"))}>Review transaction</Button></div>{salesDialog && <Feedback {...task} />}</dialog>
    {transactionReviewOpen && mode === "transaction" && record && <OrderDialog title={record.action?.kind === "disable" ? record.action.disabled ? "Pause sales" : "Resume sales" : "Update offer"} onClose={() => setTransactionReviewOpen(false)}><TransactionPanel key={record.id} record={record} subject={product.title} onChange={setRecord} onFinalized={finalized} onRetry={() => prepare(record.action!.kind as "update" | "disable")} compactReview /><Feedback {...task} /></OrderDialog>}
    {!salesDialog && <Feedback {...task} />}
  </section>;
}
