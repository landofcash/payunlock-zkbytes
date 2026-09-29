import { DeliverySession } from "./delivery-session";
import { RefreshCw as ButtonRefreshCw, Eye as ButtonEye, Save as ButtonSave, LockKeyhole as ButtonLockKeyhole, MessageSquare, AlertCircle, ArrowRight, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSession } from "@/wallet/session-store";
import { canonical, commitment } from "@/crypto/encoding";
import { useCommerce, type Action, type OrderView, type Page } from "./client";
import type { Pending } from "./journal";
import { openDelivery, prepareDelivery, restoreReceiving, type Opening, type Order, type Service } from "./protocol";
import { deliveryRecord, protocolOrder, reference, storageService, type ChainRecord } from "./lifecycle";
import { Feedback, journal, prepareOperation, randomId, TransactionPanel, useTask } from "./ui";
import type { Operation } from "./purchase-journal";
import { OrderDialog } from "./OrderPresentation";
import { SellerDeliveryProgress } from "./SellerDeliveryProgress";
import type { OrderRole } from "./order-routes";
import { Arbitration } from "./Arbitration";
import type { ItemKeyPair } from "@zkbytes/sdk";
import type { LabWalletSession } from "@/wallet/types";

export function recoveryId(order: Order, kind: "delivery" | "message", turn: string, sender: string) {
  return commitment("payunlock-pending-v1", { deployment: order.deployment, orderId: order.orderId, kind, turn, sender });
}
export function Fulfillment({ view, refresh, actions, onAcceptDelivery, renderSummary, renderHistory, role }: { role?: OrderRole; view: OrderView; refresh(): Promise<void>; actions?: ReactNode; onAcceptDelivery?(): void; renderSummary?(controls: ReactNode): ReactNode; renderHistory?(completed: ReactNode): ReactNode }) {
  const wallet = useSession(), api = useCommerce(), task = useTask();
  const [order, setOrder] = useState<Order>(), [service, setService] = useState<Service>();
  const [services, setServices] = useState<{ id: number; label: string }[]>([]);
  const [rows, setRows] = useState<ChainRecord[]>([]), [nextCursor, setNextCursor] = useState<string | null>(null), [opened, setOpened] = useState<Record<string, Opening>>({});
  const [text, setText] = useState(""), [pending, setPending] = useState<Pending>(), [pendingKey, setPendingKey] = useState("");
  const [operation, setOperation] = useState<Operation>(), [notice, setNotice] = useState("");
  const [composer, setComposer] = useState(false), [messageReviewOpen, setMessageReviewOpen] = useState(false), [arbitrationReviewOpen, setArbitrationReviewOpen] = useState(false), [deliveryReviewOpen, setDeliveryReviewOpen] = useState(false), [reviewing, setReviewing] = useState(false), [deliveryDialogOpen, setDeliveryDialogOpen] = useState(false), [caseOpen, setCaseOpen] = useState(role === "arbitrator"), [hasSaved, setHasSaved] = useState(false);
  const deliverySession = useRef(new DeliverySession());
  const credential = () => "";
  const [autoPublish, setAutoPublish] = useState(false);
  const account = wallet.session!.address.toLowerCase(), participant = [view.order.buyer, view.order.seller].includes(account);
  const isDelivery = pending?.record.kind === "delivery" || (view.order.state <= 2 && account === view.order.seller);
  const recovery = deliverySession.current;
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; deliverySession.current.clear(); }; }, []);
  async function initialize() {
    const d = await api.read<Order["deployment"]>("/deployment");
    const currentOrder = protocolOrder(view, d);
    const offered = (await api.read<{ items: { id: number; label: string }[] }>("/storage-services")).items;
    setServices(offered);
    const s = storageService(await api.read(`/storage-service?id=${offered[0]?.id ?? 1}`));
    const r = await api.request<Page<ChainRecord>>(`/orders/${view.orderId}/records`);
    if (!live.current) return;
    setOrder(currentOrder); setService(s); setRows(r.items); setNextCursor(r.nextCursor);
    const ops = await journal.list(account);
    setOperation(ops.filter(o => o.orderId === view.orderId && o.id.startsWith("lifecycle:") && o.deployment.chainId === d.chainId && o.deployment.contract.toLowerCase() === d.contract.toLowerCase()).at(-1));
  }
  useEffect(() => { void task.run(initialize); }, []); // Mounted per account/order, no background wallet prompts.
  useEffect(() => { let current = true; void api.request<Page<ChainRecord>>(`/orders/${view.orderId}/records`).then(r => { if (current) { setRows(r.items); setNextCursor(r.nextCursor); } }).catch(() => {}); return () => { current = false; }; }, [view.order.state, view.order.turn]);
  async function prepareAction(action: Action) {
    if (!order) throw new Error("Order is still loading.");
    const latest = await journal.list(account);
    if (latest.some(o => o.orderId === view.orderId && o.progress === "checking")) throw new Error("Check the pending transaction before starting another action.");
    setAutoPublish(false);
    const record: Operation = { id: `lifecycle:${randomId()}`, account, deployment: order.deployment, orderId: view.orderId, hashes: [], progress: "draft", version: 0 };
    const result = await prepareOperation(api, record, action);
    if (live.current) { setOperation(result); if (["reserveDelivery", "publishDelivery"].includes(action.kind)) setDeliveryReviewOpen(true); if (["requestArbitration", "approveArbitrationFee", "submitArbitrationEvidence", "requestArbitrationEvidence", "resolveArbitration"].includes(action.kind)) setArbitrationReviewOpen(true); }
  }
  async function create() {
    if (!order || !service || !text.trim()) throw new Error("Enter delivery or message text first.");
    const existing = await journal.list(account);
    if (existing.some(o => o.orderId === view.orderId && o.progress === "checking")) throw new Error("Check the pending transaction before sending another message.");
    if (existing.some(o => o.orderId === view.orderId && ["draft", "review"].includes(o.progress) && (o.action?.kind === "openDispute" || o.action?.kind === "replyToDispute"))) throw new Error("Review or discard the message transaction already prepared for this order.");
    const current = await api.request<OrderView>(`/orders/${view.orderId}`);
    const kind = current.order.state <= 2 && current.order.seller === account ? "delivery" : "message";
    if (kind === "delivery" ? current.canceled || (current.order.state === 2 && BigInt(current.order.publicationDeadline) <= BigInt(current.block.timestamp)) : !(current.eligibility.openDispute || current.eligibility.reply)) throw new Error("This action is no longer available. Refresh the order.");
    const turn = kind === "delivery" ? "0" : String(BigInt(current.order.turn) + 1n);
    const key = recoveryId(order, kind, turn, account);
    const prepare = async (session: LabWalletSession, isCurrent: () => boolean, offerKeys?: ItemKeyPair) => {
      const selectedService = storageService(await api.read(`/storage-service?id=${service.id}&prepare=true`));
      const prepared = await prepareDelivery({ order, payload: { text, tickets: [] }, kind, turn, signer: session, service: selectedService, latestPublicationSeconds: current.order.state === 2 ? BigInt(current.order.publicationDeadline) : BigInt(Math.max(current.block.timestamp, Math.floor(Date.now() / 1000))) + BigInt(current.order.terms.commitmentWindow), isCurrent, offerKeys });
      if (!isCurrent() || !live.current) throw new Error("Wallet changed.");
      await recovery.prepare(prepared, credential(), isCurrent);
      if (isCurrent() && live.current) { setPending(preparedPending(prepared)); setPendingKey(key); }
    };
    if (kind === "delivery") await wallet.runOfferKeysOperation(order.seller.context, order.seller.publicKey, (keys, session, current) => prepare(session, current, keys));
    else await wallet.runOperation(prepare);
    if (kind === "delivery") setNotice("Delivery prepared. Continue to publication.");
    return { pending: await deliverySession.current.restore(key), key };
  }
  async function clearPublished(records: ChainRecord[]) {
    if (!order) return false;
    const key = pendingKey || recoveryId(order, "delivery", "0", account);
    const published = records.find(row => pending ? row.turn === pending.record.turn && row.commitment === pending.recordHash : row.turn === "0");
    if (!published || !await recovery.cleanupConfirmed(key, published.commitment, credential())) return false;
    if (live.current) { setPending(undefined); setHasSaved(false); setText(""); setComposer(false); deliverySession.current.clear(); }
    return true;
  }
  async function continueDelivery(automaticallyPublish = false, prepared = pending, key = pendingKey) {
    if (!prepared || !service || !order) throw new Error("Unlock the saved draft first.");
    if ((await journal.list(account)).some(o => o.orderId === view.orderId && o.deployment.chainId === order.deployment.chainId && o.deployment.contract.toLowerCase() === order.deployment.contract.toLowerCase() && o.progress === "checking")) throw new Error("Check the pending transaction before continuing this draft.");
    let p = await recovery.restore(key, credential());
    if (canonical(p.record.order) !== canonical(order) || p.record.sender !== account) throw new Error("Draft belongs to another order or wallet.");
    const current = () => live.current;
    const savedService = storageService(await api.read(`/storage-service?id=${p.record.serviceId}`));
    if (p.progress === "prepared") await recovery.upload(key, credential(), savedService.client, current);
    p = await recovery.restore(key, credential());
    if (p.progress === "upload-uncertain") {
      const outcome = await recovery.recoverUpload(key, credential(), savedService.client, current);
      if (outcome === "not-found") await recovery.upload(key, credential(), savedService.client, current);
      else if (outcome !== "active") throw new Error(p.record.kind === "message" ? `Storage status: ${outcome}. Try sending the message again.` : `Storage status: ${outcome}. Keep this draft; do not prepare a replacement.`);
    }
    p = await recovery.restore(key, credential()); setPending(p);
    const fresh = await api.request<OrderView>(`/orders/${view.orderId}`);
    const existing = await api.request<Page<ChainRecord>>(`/orders/${view.orderId}/records?after=${BigInt(p.record.turn) - 1n}&limit=1`);
    if (existing.items.some(row => row.turn === p.record.turn && row.commitment === p.recordHash)) {
      const ops = await journal.list(account);
      for (const op of ops.filter(o => o.orderId === view.orderId && o.progress === "checking")) {
        const a = op.action;
        if (a && "reference" in a && JSON.stringify(a.reference) === JSON.stringify(reference(p.record))) setOperation(await journal.save({ ...op, progress: "finalized", transaction: undefined }));
      }
      await clearPublished(existing.items); setRows(existing.items); setNotice("This exact content is already published and finalized."); await refresh(); return;
    }
    if (p.record.kind === "message") {
      if (BigInt(fresh.order.turn) + 1n !== BigInt(p.record.turn)) throw new Error("The negotiation turn changed. This draft cannot be posted to another turn.");
      if (!fresh.eligibility.openDispute && !fresh.eligibility.reply) throw new Error("This message can no longer be sent. Refresh the order.");
      await prepareAction(fresh.eligibility.openDispute ? { kind: "openDispute", orderId: view.orderId, reference: reference(p.record) } : { kind: "replyToDispute", orderId: view.orderId, expectedTurn: p.record.turn, reference: reference(p.record) });
      if (live.current) { setPending(undefined); deliverySession.current.clear(); }
      return;
    }
    if (fresh.order.state === 1) {
      if (p.progress === "uploaded") await recovery.update(key, credential(), "tx1-pending");
      await prepareAction({ kind: "reserveDelivery", orderId: view.orderId });
    } else if (fresh.order.state === 2) {
      let hash = p.tx1;
      const ops = await journal.list(account);
      hash ??= ops.filter(o => o.orderId === view.orderId && o.action?.kind === "reserveDelivery").at(-1)?.activeHash ?? null;
      if (!hash) {
        let after: string | null = null;
        do {
          const page: Page<{ name: string; transactionHash: string }> = await api.request(`/orders/${view.orderId}/history${after ? `?after=${after}` : ""}`);
          hash = page.items.find(row => row.name === "DeliveryReserved")?.transactionHash ?? null; after = page.nextCursor;
        } while (!hash && after);
      }
      if (!hash) throw new Error("Reservation is finalized. Waiting for its transaction hash to sync; keep this draft and retry.");
      const check = await api.request<{ eligible: boolean; reason: string }>(`/orders/${view.orderId}/publication-check`, { reservationTransaction: hash });
      if (!check.eligible) throw new Error(`Delivery cannot be published: ${check.reason}. Check refund eligibility.`);
      for (const op of ops.filter(o => o.orderId === view.orderId && o.progress === "checking" && o.action?.kind === "reserveDelivery")) {
        await journal.save({ ...op, activeHash: hash, progress: "finalized", transaction: undefined });
      }
      const reviewStart = Math.max(Number(fresh.order.terms.eventEnd), Math.floor(Date.now() / 1000), fresh.block.timestamp);
      if ((reviewStart + Number(fresh.order.terms.reviewWindow)) * 1000 >= Date.parse(p.record.expiresAt)) throw new Error("Delivery no longer covers the promised review period.");
      if (["uploaded", "tx1-pending"].includes(p.progress)) { await recovery.update(key, credential(), "tx1-pending", hash); await recovery.update(key, credential(), "tx1-finalized"); }
      p = await recovery.restore(key, credential());
      if (p.progress === "tx1-finalized") await recovery.update(key, credential(), "tx2-pending");
      await prepareAction({ kind: "publishDelivery", orderId: view.orderId, reference: reference(p.record), reservationTransaction: hash });
      setAutoPublish(automaticallyPublish);
      setNotice("Reservation finalized. Approve publication now, before the fixed deadline. Delivery is not complete until publication finalizes.");
    } else throw new Error("This draft cannot be published in the current order state. Check refund eligibility.");
    setPending(await recovery.restore(key, credential()));
  }
  async function finalized() {
    await refresh();
    if (operation?.action?.kind === "reserveDelivery" && pending) await continueDelivery(true);
    else {
      const r = await api.request<Page<ChainRecord>>(`/orders/${view.orderId}/records`); setRows(r.items); setNextCursor(r.nextCursor);
       if (operation?.action?.kind === "openDispute" || operation?.action?.kind === "replyToDispute") { setMessageReviewOpen(false); setNotice("Message sent. The order history is updating."); }
       else if (operation?.action?.kind === "approveArbitrationFee") { setArbitrationReviewOpen(false); setOperation(undefined); setNotice("Fee token approved. Continue the arbitration request."); }
       else if (arbitrationOperation) { setArbitrationReviewOpen(false); setNotice("Arbitration action confirmed. The order is updating."); }
      else if (operation?.action?.kind === "publishDelivery") {
        if (await clearPublished(r.items)) setNotice("Content published and finalized. Temporary draft cleared.");
        else setNotice("Transaction finalized. Publication history is syncing; keep the draft until confirmed.");
      }
    }
  }
  useEffect(() => { if (!task.busy && pending && rows.some(row => row.turn === pending.record.turn && row.commitment === pending.recordHash)) void clearPublished(rows).catch(() => {}); }, [rows, pending, task.busy]);
  async function open(row: ChainRecord) {
    if (!order || !service) return;
    const role = account === view.order.buyer ? "buyer" : "seller";
    const inspect = async (privateKey: Uint8Array, isCurrent: () => boolean) => openDelivery({ record: deliveryRecord(row, order), expectedRecordHash: row.commitment, order, role, privateKey, services: [storageService(await api.read(`/storage-service?id=${row.reference.serviceId}`))], isCurrent });
    const result = role === "seller" ? await wallet.runOfferKeysOperation(order.seller.context, order.seller.publicKey, (keys, _session, current) => inspect(keys.encryptionPrivateKey, current)) : await wallet.runOperation(async (session, isCurrent) => {
      const identity = await restoreReceiving(order[role].context, session, isCurrent, order[role].publicKey);
      try { return await inspect(identity.privateKey, isCurrent); }
      finally { identity.privateKey.fill(0); }
    });
    if (live.current) setOpened(previous => ({ ...previous, [row.turn]: result }));
  }
  const messageOperation = operation && (operation.action?.kind === "openDispute" || operation.action?.kind === "replyToDispute") ? operation : undefined;
  const arbitrationOperation = operation && ["requestArbitration", "approveArbitrationFee", "submitArbitrationEvidence", "requestArbitrationEvidence", "resolveArbitration"].includes(operation.action?.kind ?? "") ? operation : undefined;
  const deliveryOperation = operation && !messageOperation && !arbitrationOperation ? operation : undefined;
  const messageTransactionPending = messageOperation && ["draft", "review", "checking"].includes(messageOperation.progress);
  const canCompose = participant && !messageTransactionPending && ((view.order.state <= 2 && account === view.order.seller && !view.canceled && (view.order.state === 1 || BigInt(view.order.publicationDeadline) > BigInt(view.block.timestamp))) || view.eligibility.openDispute || view.eligibility.reply);
  const contentPublished = pending && (pending.progress === "published" || (pending.record.kind === "delivery" ? view.order.state >= 3 : BigInt(view.order.turn) >= BigInt(pending.record.turn)) || rows.some(row => row.turn === pending.record.turn && row.commitment === pending.recordHash));
  const activeDraft = pending && !contentPublished;
  const unfinishedKind = pending?.record.kind ?? (view.order.state <= 2 ? "delivery" : "message");
  const hasUnfinished = isDelivery && view.order.state < 6 && (!!activeDraft || (!contentPublished && hasSaved));
  const title = view.order.state <= 2 ? view.order.state === 2 ? "Prepare delivery again" : "Prepare delivery" : view.eligibility.openDispute ? "Report a problem" : "Reply";
  const delivery = rows.find(row => row.turn === "0");
  const canReportProblem = role === "buyer" && !!view.eligibility.openDispute && !hasUnfinished && !messageTransactionPending;
  const controls = <>{participant && (delivery || canReportProblem) && <Button icon={ButtonEye} disabled={task.busy || wallet.busy} onClick={() => { setDeliveryDialogOpen(true); if (delivery && !opened["0"]) void task.run(() => open(delivery)); }}>Open delivery</Button>}    {role !== "seller" && actions}
    {hasUnfinished && !(deliveryOperation && deliveryOperation.progress !== "finalized") && <div className="card unfinished-content"><div><h3>You have an unfinished {unfinishedKind}</h3><p>Continue from where you left off.</p></div><Button icon={ArrowRight} disabled={task.busy} onClick={() => void task.run(() => continueDelivery())}>Retry publication</Button></div>}
    {canCompose && !hasUnfinished && !canReportProblem && <Button icon={view.eligibility.reply ? MessageSquare : ButtonSave} disabled={task.busy} onClick={() => { setComposer(true); setReviewing(false); if (contentPublished) setPending(undefined); }}>{title}</Button>}


    {role === "seller" && actions}
    {(view.assignment || view.eligibility.requestArbitration) && role !== "arbitrator" && <Button icon={ButtonEye} variant="secondary" onClick={() => setCaseOpen(!caseOpen)}>{caseOpen ? "Hide case" : view.assignment ? "View case" : "Explore arbitration"}</Button>}</>;
  return <section className={"lifecycle order-content " + (role ?? (account === view.order.seller ? "seller" : "buyer")) + "-order-workspace"}>{renderSummary ? renderSummary(controls) : <div className="order-card-actions">{controls}</div>}{role === "seller" && <SellerDeliveryProgress state={view.order.state} canceled={view.canceled} />}{!deliveryDialogOpen && !deliveryReviewOpen && <Feedback {...task} />}{notice && <p role="status">{notice}</p>}
    {!order && !task.busy && <Button icon={ButtonRefreshCw} onClick={() => void task.run(initialize)}>Retry delivery loading</Button>}
    {deliveryDialogOpen && <OrderDialog title="Delivery" onClose={() => setDeliveryDialogOpen(false)}>
      {opened["0"] ? <div className="order-delivery-content"><p className="verified-content"><Check size={16} />Content verified</p><p className="description">{opened["0"].payload.text}</p>{opened["0"].payload.tickets.map(t => <p className="delivery-ticket" key={t.row}>{t.ticket}</p>)}</div> : <p className="muted">{delivery ? task.busy ? "Opening delivery..." : "Delivery could not be opened. Try again or report a problem." : "Delivery content has not loaded yet. Refresh the order or report a problem."}</p>}
      {delivery && !opened["0"] && !task.busy && <Button icon={ButtonEye} variant="secondary" disabled={wallet.busy} onClick={() => void task.run(() => open(delivery))}>Try opening again</Button>}
      <Feedback {...task} />
      <div className="dialog-actions order-delivery-dialog-actions">
        {canReportProblem && <Button icon={AlertCircle} variant="secondary" disabled={task.busy} onClick={() => { setDeliveryDialogOpen(false); setComposer(true); setReviewing(false); if (contentPublished) setPending(undefined); }}>Report a problem</Button>}
        {opened["0"] && onAcceptDelivery && <Button icon={Check} disabled={task.busy || wallet.busy} onClick={() => { setDeliveryDialogOpen(false); onAcceptDelivery(); }}>Accept delivery</Button>}
      </div>
    </OrderDialog>}
    {participant && (rows.some(row => row.turn !== "0") || [4, 5].includes(view.order.state) || (messageOperation && messageOperation.progress !== "finalized")) && <section className="order-conversation"><h2>Conversation</h2>{messageOperation && messageOperation.progress !== "finalized" && !messageReviewOpen && <div className="card"><p>{messageOperation.progress === "checking" ? "Message confirmation is pending." : messageOperation.progress === "reverted" ? "The message was not sent." : "Your message is ready to send."}</p><Button icon={ArrowRight} variant="secondary" onClick={() => setMessageReviewOpen(true)}>{messageOperation.progress === "checking" ? "Check message status" : "Continue sending"}</Button></div>}{rows.filter(row => row.turn !== "0").map(row => <article className="card" key={row.turn}><h3>{row.sender === account ? "You" : row.sender === view.order.buyer ? "Buyer" : "Seller"} - Message {row.turn}</h3>{opened[row.turn] ? <><p className="description">{opened[row.turn]!.payload.text}</p>{opened[row.turn]!.payload.tickets.map(t => <p key={t.row}>{t.ticket}</p>)}</> : <Button icon={ButtonEye} variant="secondary" disabled={task.busy || wallet.busy} onClick={() => void task.run(() => open(row))}>Open message</Button>}</article>)}</section>}
    {nextCursor && <Button icon={ButtonEye} variant="secondary" onClick={() => void task.run(async () => { const p = await api.request<Page<ChainRecord>>('/orders/' + view.orderId + '/records?after=' + nextCursor); setRows(r => [...r, ...p.items]); setNextCursor(p.nextCursor); })}>Load more messages</Button>}
    {((composer && canCompose) || (messageReviewOpen && messageOperation && messageOperation.progress !== "finalized")) && <OrderDialog title={messageReviewOpen && messageOperation ? messageOperation.action?.kind === "openDispute" ? "Send problem report" : "Send reply" : title} onClose={() => { if (!task.busy) { setComposer(false); setMessageReviewOpen(false); } }}>
      {messageReviewOpen && messageOperation ? <><p>Your encrypted message is ready. Choose how to send it.</p><TransactionPanel key={messageOperation.id} record={messageOperation} onChange={setOperation} onFinalized={finalized} compactReview />{messageOperation.progress === "reverted" && <Button icon={ButtonRefreshCw} variant="secondary" disabled={task.busy} onClick={() => void task.run(() => prepareAction(messageOperation.action!))}>Prepare transaction again</Button>}<Feedback {...task} /></> : <>
      <ol className="order-compose-steps" aria-label="Content steps">
        <li className={!reviewing ? "current" : ""}>1. Prepare content</li>
        <li className={reviewing ? "current" : ""}>2. Review</li>
        <li>3. Send</li>
      </ol>
      {!reviewing ? <>
        <label>{isDelivery ? "Delivery content" : "Message"}<textarea value={text} maxLength={65536} onChange={e => setText(e.target.value)} /></label>
        {services.length > 1 && <label>Storage for new content<select value={service?.id} onChange={e => void task.run(async () => setService(storageService(await api.read('/storage-service?id=' + e.target.value + '&prepare=true'))))}>{services.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>}
        <Button icon={ArrowRight} disabled={!text.trim() || task.busy} onClick={() => setReviewing(true)}>Review content</Button>
      </> : <>
        <div className="card"><p className="description">{text}</p></div>
        <p>{isDelivery ? view.order.state === 2 ? "The order is already reserved. Publish before the original deadline; it cannot be extended." : "Sending requires two transactions: reserve delivery, then publish it before the deadline." : view.eligibility.openDispute ? "Sending this message opens a dispute and pauses the normal payout. The seller will have a response deadline." : "Sending your response starts the other participant's response window."}</p>
        <p>Content is encrypted before upload. Your wallet may ask you to restore your encryption keys.</p>
        <div className="order-actions">
          <Button icon={ButtonSave} variant="secondary" disabled={task.busy} onClick={() => setReviewing(false)}>Edit content</Button>
          <Button icon={ButtonLockKeyhole} disabled={task.busy || wallet.busy} onClick={() => void task.run(async () => { const prepared = await create(); await continueDelivery(false, prepared.pending, prepared.key); setComposer(false); setText(""); if (prepared.pending.record.kind === "delivery") setHasSaved(true); else setMessageReviewOpen(true); })}>{isDelivery ? "Send delivery" : "Continue to transaction"}</Button>
        </div>
      </>}
      <Feedback {...task} /></>}
    </OrderDialog>}
    {renderHistory?.(operation?.progress === "finalized" ? <TransactionPanel record={operation} onChange={setOperation} /> : null)}
    {deliveryOperation && deliveryOperation.progress !== "finalized" && <>{!deliveryReviewOpen && <section className="order-pending"><h2>Delivery processing</h2><p>{deliveryOperation.progress === "checking" ? "Delivery transaction confirmation is pending." : deliveryOperation.progress === "reverted" ? "The delivery transaction failed. Review it to try again." : "Your delivery transaction is ready to send."}</p><Button icon={ArrowRight} variant="secondary" onClick={() => setDeliveryReviewOpen(true)}>{deliveryOperation.progress === "checking" ? "Check delivery status" : "Review delivery transaction"}</Button></section>}{deliveryReviewOpen && <OrderDialog title="Delivery processing" onClose={() => { if (!task.busy) setDeliveryReviewOpen(false); }}><TransactionPanel key={deliveryOperation.id} record={deliveryOperation} onChange={setOperation} onFinalized={finalized} autoSubmit={autoPublish} compactReview /><Feedback {...task} /></OrderDialog>}</>}
    {arbitrationOperation && arbitrationOperation.progress !== "finalized" && <>{!arbitrationReviewOpen && <section className="order-pending"><h2>Arbitration transaction</h2><p>{arbitrationOperation.progress === "checking" ? "Confirmation is pending." : arbitrationOperation.progress === "reverted" ? "The transaction failed. Review it to try again." : "Review the prepared action before confirming."}</p><Button icon={ArrowRight} variant="secondary" onClick={() => setArbitrationReviewOpen(true)}>{arbitrationOperation.progress === "checking" ? "Check transaction status" : "Review transaction"}</Button></section>}{arbitrationReviewOpen && <OrderDialog title="Arbitration transaction" onClose={() => { if (!task.busy) setArbitrationReviewOpen(false); }}><TransactionPanel key={arbitrationOperation.id} record={arbitrationOperation} onChange={setOperation} onFinalized={finalized} compactReview />{arbitrationOperation.progress === "reverted" && <Button icon={ButtonRefreshCw} variant="secondary" disabled={task.busy} onClick={() => void task.run(() => prepareAction(arbitrationOperation.action!))}>Prepare transaction again</Button>}<Feedback {...task} /></OrderDialog>}</>}
    {caseOpen && (view.assignment || view.eligibility.requestArbitration) && order && service && <section className="order-case"><h2>Arbitration case</h2><p>{view.assignment ? "Review evidence, requests and the assigned arbitrator." : "If you cannot reach an agreement, you can ask an independent arbitrator to decide."}</p>{caseOpen && <Arbitration key={view.assignment?.revision ?? "entry"} view={view} order={order} service={service} prepareAction={prepareAction} />}</section>}
  </section>;
}
function preparedPending(p: Awaited<ReturnType<typeof prepareDelivery>>): Pending { return { ...p, version: 1, progress: "prepared", tx1: null, tx2: null }; }
