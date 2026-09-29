import { Check as ButtonCheck, ArrowLeft, ArrowRight, Globe, Link as LinkIcon, Pencil, CheckCircle2, Coins, Info, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { formatUnits, hexlify } from "ethers";
import { useSession } from "@/wallet/session-store";
import { useCommerce, useCommerceAccess, type OfferImage, type Product, type RegistrationConfiguration } from "./client";
import { ManageOffer } from "./ManageOffer";
import { OfferReview } from "./OfferReview";
import { OfferFields } from "./OfferFields";
import { registrationMatches } from "./registration";
import { newOfferReceivingContext } from "./protocol";
import type { Operation } from "./purchase-journal";
import { Feedback, journal, native, prepareOperation, randomId, TransactionPanel, useTask, WalletGate } from "./ui";
import { OrderDialog } from "./OrderPresentation";
const initial = { title: "", description: "", visibility: "draft" as const, draftTerms: { token: native, price: "1000000000000000", eventEnd: null as string | null, reviewWindow: null as string | null, commitmentWindow: 600 } };
type FeePolicy = { serviceFeeBps?: number; offerPlacementFee?: string; placementFeeVersion?: string };
function PublicationInfo({ serviceFeeBps }: { serviceFeeBps?: number }) {
  const [open, setOpen] = useState(false), id = useId(), container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  return <div className="offer-publication-help" ref={container}>
    <Button icon={Info} size="icon" variant="ghost" aria-label="About publishing fees and visibility" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)} />
    {open && <div id={id} className="offer-publication-popup" role="dialog" aria-label="Publishing fees and visibility"><div className="offer-publication-popup-heading"><strong>Publishing details</strong><Button icon={X} size="icon" variant="ghost" aria-label="Close publishing details" onClick={() => setOpen(false)} /></div>
      {serviceFeeBps !== undefined && <p>Service fee: up to {(serviceFeeBps / 100).toFixed(2)}% of your payout on completed sales.</p>}
      <p>Public offers appear in Discover; private offers are available by link.</p>
    </div>}
  </div>;
}
export function SellerEditor() {
  const { id } = useParams(), navigate = useNavigate(), wallet = useSession(), api = useCommerce(), access = useCommerceAccess(), task = useTask();
  const [product, setProduct] = useState<Product>(), [form, setForm] = useState<Omit<Product, "id" | "revision">>(initial), [record, setRecord] = useState<Operation>(), [confirmed, setConfirmed] = useState<RegistrationConfiguration>(), [defaultReview, setDefaultReview] = useState<string>(), [fieldsValid, setFieldsValid] = useState(false);
  const [query] = useSearchParams();
  const [stage, setStage] = useState<"edit" | "review" | "transaction">("edit");
  const [published, setPublished] = useState(false);
  const [publicationReviewOpen, setPublicationReviewOpen] = useState(false);
  const [visibility, setVisibility] = useState<"public" | "hidden">();
  const [bounds, setBounds] = useState<{ minCommitmentWindow: number; maxCommitmentWindow: number }>();
  const [feePolicy, setFeePolicy] = useState<FeePolicy>();
  const [stagedImages, setStagedImages] = useState<File[]>([]), [pendingReview, setPendingReview] = useState(false);
  const sourceEpoch = id ? wallet.sessionEpoch : 0;
  useEffect(() => { void task.run(async () => { const policy = await api.read<FeePolicy & { minCommitmentWindow: number; maxCommitmentWindow: number }>("/platform"); setBounds(policy); setFeePolicy(policy); if (id && wallet.session) await load(); }); }, [id, sourceEpoch]);
  async function load() {
    if (!id) return;
    const p = await api.request<Product>(`/seller/products/${id}`); setProduct(p); setForm({ title: p.title, description: p.description, images: p.images, visibility: p.visibility, draftTerms: p.draftTerms });
    let configuration: RegistrationConfiguration | undefined;
    try { configuration = (await api.request<{ configuration: RegistrationConfiguration }>(`/seller/products/${id}/registration`)).configuration; setConfirmed(configuration); } catch { setConfirmed(undefined); }
    const rows = await journal.list(wallet.session!.address); let pending = rows.filter(r => r.productId === id && !r.requestId).at(-1);
    if (pending?.progress === "checking" && configuration && registrationMatches(pending, configuration)) pending = await journal.save({ ...pending, progress: "finalized" });
    setRecord(pending);
    if (pending?.publication && (p.visibility === "draft" || pending.progress !== "finalized") && ["review", "checking", "finalized", "reverted"].includes(pending.progress)) { setStage("transaction"); setPublished(pending.progress === "finalized" && p.visibility === pending.publication.visibility && p.revision > pending.publication.revision); }
    else setStage(p.visibility === "draft" && query.get("step") === "review" ? "review" : "edit");
  }
  useEffect(() => { void api.read<{ reviewWindow: string }>("/deployment").then(d => setDefaultReview(d.reviewWindow)).catch(() => {}); }, []);
  useEffect(() => { setProduct(undefined); setForm(initial); setStagedImages([]); setPendingReview(false); setRecord(undefined); setConfirmed(undefined); setPublished(false); setVisibility(undefined); setStage(query.get("step") === "review" ? "review" : "edit"); }, [id]);
  useEffect(() => { if (pendingReview && access.authenticated && wallet.session && fieldsValid && !task.busy) { setPendingReview(false); void saveDraft(); } }, [pendingReview, access.authenticated, wallet.session, fieldsValid, task.busy]);
  function save(event: FormEvent) {
    event.preventDefault();
    if (!fieldsValid || task.busy) return;
    if (!access.authenticated || !wallet.session) { setPendingReview(true); access.authorize(); return; }
    void saveDraft();
  }
  async function saveDraft() {
    let createdId: string | undefined; await task.run(async () => {
      const current = await api.read<{ minCommitmentWindow: number; maxCommitmentWindow: number }>("/platform"); setBounds(current);
      if (!form.draftTerms || !fieldsValid) throw new Error("Review the offer fields before saving.");
      if (form.draftTerms.commitmentWindow < current.minCommitmentWindow || form.draftTerms.commitmentWindow > current.maxCommitmentWindow) throw new Error("Publication bounds changed. Review and update the duration.");
      const images = [...(form.images ?? [])];
      for (const file of stagedImages) {
        const image = await api.request<OfferImage>("/seller/images", file);
        images.push(image);
        setForm(value => ({ ...value, images: [...images] }));
        setStagedImages(value => value.slice(1));
      }
      const body = { title: form.title, description: form.description, images, visibility: form.visibility, draftTerms: form.draftTerms };
      const p = id ? await api.request<Product>(`/seller/products/${id}`, { ...body, expectedRevision: product!.revision }, "PUT") : await api.request<Product>("/seller/products", body);
      setProduct(p); setForm({ title: p.title, description: p.description, images: p.images, visibility: p.visibility, draftTerms: p.draftTerms });
      if (!confirmed || p.visibility === "draft") { if (id) setStage("review"); else createdId = p.id; }
    });
    if (createdId) navigate(`/sales/products/${createdId}?step=review`);
  }
  async function prepare(kind: "create" | "update" | "disable", disabled = true, visibility?: "public" | "hidden") {
    if (!product || !wallet.session) throw new Error("Save and reload the draft first.");
    if (JSON.stringify(form.draftTerms) !== JSON.stringify(product.draftTerms) || form.title !== product.title || form.description !== product.description || JSON.stringify(form.images ?? []) !== JSON.stringify(product.images ?? [])) throw new Error("Save draft changes before registering them.");
    if (record?.progress === "checking") throw new Error("Wait for the current transaction to complete before making changes.");
    let next = record;
    if (!next || next.progress === "finalized") {
      const deployment = await api.read<{ chainId: 10143; contract: string }>("/deployment");
      const d = { chainId: deployment.chainId, contract: deployment.contract };
      const context = record?.context ?? (confirmed ? { version: 1 as const, deployment: d, account: wallet.session.address.toLowerCase(), nonce: confirmed.sellerReceiving.nonce } : newOfferReceivingContext(d, wallet.session.address, product.id));
      next = await journal.save({ id: randomId(), account: wallet.session.address.toLowerCase(), deployment: context.deployment, productId: product.id, context, receiving: record?.receiving ?? confirmed?.sellerReceiving, hashes: [], progress: "draft", version: 0 }); setRecord(next);
    }
    if (visibility) { next = await journal.save({ ...next, publication: { visibility, revision: product.revision } }); setRecord(next); setPublished(false); }
    if (!next.receiving) {
      const receiving = await wallet.runOfferKeysOperation(next.context!, undefined, async keys => ({ nonce: next!.context!.nonce, publicKey: hexlify(keys.encryptionPublicKey) }));
      next = await journal.save({ ...next, receiving }); setRecord(next);
    }
    // Catalog UUID deterministically identifies this product. It survives lost local state.
    const productKey = `0x${product.id.replaceAll("-", "").padStart(64, "0")}`;
    await api.request(`/seller/products/${product.id}/registration`, { productKey }, "PUT");
    let action: Parameters<typeof prepareOperation>[2] = kind === "disable" ? { kind, productId: product.id, disabled } : { kind, productId: product.id, receiving: next.receiving! };
    if (kind === "create" && feePolicy?.offerPlacementFee !== undefined) {
      const latest = await api.read<FeePolicy>("/platform");
      if (latest.offerPlacementFee !== feePolicy.offerPlacementFee || latest.placementFeeVersion !== feePolicy.placementFeeVersion || latest.serviceFeeBps !== feePolicy.serviceFeeBps) { setFeePolicy(latest); throw new Error("Offer fees changed. Review the updated fee before publishing."); }
      action = { kind: "create", productId: product.id, receiving: next.receiving!, feeCapBps: feePolicy.serviceFeeBps!, expectedPlacementFee: feePolicy.offerPlacementFee, expectedFeeVersion: feePolicy.placementFeeVersion };
    }
    setRecord(await prepareOperation(api, next, action));
    if (visibility) { setStage("transaction"); setPublicationReviewOpen(true); }
  }
  async function finishPublication() {
    if (!product || !record) return;
    const result = await api.request<{ configuration: RegistrationConfiguration }>(`/seller/products/${product.id}/registration`);
    setConfirmed(result.configuration);
    if (!record.publication) return;
    if (!registrationMatches(record, result.configuration)) throw new Error("Confirmed settings do not match this publication. Review the offer before continuing.");
    const current = await api.request<Product>(`/seller/products/${product.id}`);
    const intent = record.publication;
    if (current.revision !== intent.revision) {
      if (current.revision === intent.revision + 1 && current.visibility === intent.visibility) { setProduct(current); setPublished(true); return; }
      throw new Error("This draft changed in another session. Review its latest version before publishing.");
    }
    const saved = await api.request<Product>(`/seller/products/${product.id}`, { title: current.title, description: current.description, images: current.images, draftTerms: current.draftTerms, visibility: intent.visibility, expectedRevision: current.revision }, "PUT");
    setProduct(saved); setForm({ title: saved.title, description: saved.description, images: saved.images, visibility: saved.visibility, draftTerms: saved.draftTerms }); setPublished(true);
  }
  const wizard = !confirmed || product?.visibility === "draft" || (!!record?.publication && stage === "transaction");
  if (id && !wallet.session) return <section className="commerce-page"><h1>Create an offer</h1><WalletGate /></section>;
  if (!wizard && product && confirmed) return task.busy ? <section className="commerce-page"><Feedback {...task} /></section> : <ManageOffer key={`${product.id}:${wallet.sessionEpoch}`} initialProduct={product} configuration={confirmed} operation={record} defaultReview={defaultReview} bounds={bounds} />;
  return <section className="commerce-page"><h1>{wizard ? "Create an offer" : "Manage offer"}</h1>
    {wizard && <ol className="offer-flow-steps" aria-label="Offer creation steps">{["Create Draft", "Review Draft", "Transaction & results"].map((label, index) => <li key={label} aria-current={index === ["edit", "review", "transaction"].indexOf(stage) ? "step" : undefined}><span>{index < ["edit", "review", "transaction"].indexOf(stage) ? <ButtonCheck size={16} aria-label="Completed" /> : index + 1}</span>{label}</li>)}</ol>}
    {(!id || product) && stage === "edit" && <form className="offer-editor-form" onSubmit={event => void save(event)}>
      <OfferFields key={`${id ?? "new"}:${product?.revision ?? 0}:${id ? wallet.sessionEpoch : "draft"}`} form={form} onChange={value => { setForm(value); setPendingReview(false); }} account={wallet.session?.address} confirmed={false} defaultReview={defaultReview} bounds={bounds} onValidity={setFieldsValid} stagedImages={!id ? stagedImages : undefined} onStagedImagesChange={!id ? files => { setStagedImages(files); setPendingReview(false); } : undefined} />
      <div className="offer-save-actions"><Button icon={ArrowRight} type="submit" disabled={task.busy || !fieldsValid}>Review draft</Button></div>
      {pendingReview && !access.authenticated && <div className="offer-save-actions"><p>Sign in to save and review this draft.</p><Button variant="secondary" onClick={() => setPendingReview(false)}>Cancel</Button></div>}
      {access.error && <p role="alert">{access.error}</p>}
    </form>}
    {wizard && stage === "review" && product && <section className="card offer-review"><p className="offer-review-eyebrow">Review your draft</p><OfferReview product={product} defaultReview={defaultReview} />{!confirmed && feePolicy?.offerPlacementFee !== undefined && <div className="offer-review-notes"><p className="offer-review-fee"><Coins aria-hidden="true" />Publishing costs {formatUnits(feePolicy.offerPlacementFee, 18)} MON, paid once.</p></div>}<div className="offer-review-actions"><Button icon={Pencil} variant="secondary" disabled={task.busy} onClick={() => setStage("edit")}>Edit draft</Button><div className="offer-publish-actions"><PublicationInfo serviceFeeBps={feePolicy?.serviceFeeBps} /><div className="offer-visibility-group" role="radiogroup" aria-label="Offer visibility" onKeyDown={event => {
      if (task.busy || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? "hidden" : event.key === "End" ? "public" : visibility === "hidden" ? "public" : "hidden";
      setVisibility(next); event.currentTarget.querySelector<HTMLButtonElement>(`[data-visibility="${next}"]`)?.focus();
    }}>{(["hidden", "public"] as const).map(value => <Button key={value} role="radio" aria-checked={visibility === value} data-visibility={value} tabIndex={visibility === value || (!visibility && value === "hidden") ? 0 : -1} icon={value === "hidden" ? LinkIcon : Globe} variant={visibility === value ? "default" : "secondary"} disabled={task.busy} onClick={() => setVisibility(value)}>{value === "hidden" ? "Private" : "Public"}</Button>)}</div><Button icon={ArrowRight} disabled={task.busy || !visibility} onClick={() => { if (visibility) void task.run(() => prepare(confirmed ? "update" : "create", true, visibility)); }}>Publish</Button></div></div></section>}
    {wizard && stage === "transaction" && record && <section className="offer-publication-result">
      {published ? <div className="card"><CheckCircle2 className="publication-success-icon" aria-hidden="true" /><h2>Offer published</h2>{record.activeHash && <p className="address">Transaction: {record.activeHash}</p>}<p>{product?.visibility === "public" ? "Your offer is now listed in Discover." : "Your offer is available through its direct link."}</p><div className="actions"><Button asChild><Link to="/offers"><ArrowLeft aria-hidden="true" />Back to offers</Link></Button><Button asChild variant="secondary"><Link to={`/products/${product!.id}`}><LinkIcon aria-hidden="true" />Open offer</Link></Button></div></div> : <><h2>Review transaction and results</h2><p>{record.progress === "checking" ? "Waiting for transaction confirmation." : record.progress === "reverted" ? "The transaction failed. Review it to try again." : "Review the publishing transaction before confirming."}</p>{record.progress !== "finalized" && <Button icon={ArrowRight} onClick={() => setPublicationReviewOpen(true)}>{record.progress === "checking" ? "Check transaction status" : "Review transaction"}</Button>}
        {record.progress === "finalized" && <><p>The transaction is confirmed. Finish publishing if the last step was interrupted.</p><Button icon={ButtonCheck} disabled={task.busy} onClick={() => void task.run(finishPublication)}>Finish publishing</Button></>}
        {record.progress !== "checking" && <Button icon={ArrowLeft} variant="secondary" disabled={task.busy} onClick={() => setStage("review")}>Back to draft review</Button>}
      </>}
    </section>}
    {publicationReviewOpen && wizard && stage === "transaction" && record && !published && record.progress !== "finalized" && <OrderDialog title="Publish offer" onClose={() => setPublicationReviewOpen(false)}><p>{record.publication?.visibility === "public" ? "Publish publicly in Discover" : "Publish privately by direct link"}</p><TransactionPanel key={record.id} record={record} onChange={setRecord} onFinalized={finishPublication} compactReview />{record.progress === "reverted" && record.publication && <Button icon={ArrowRight} variant="secondary" disabled={task.busy} onClick={() => void task.run(() => prepare(record.action?.kind === "create" ? "create" : "update", true, record.publication!.visibility))}>Prepare transaction again</Button>}<Feedback {...task} /></OrderDialog>}
    <Feedback {...task} />
  </section>;

}
