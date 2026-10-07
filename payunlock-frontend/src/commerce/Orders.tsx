import { RefreshCw as ButtonRefreshCw, ArrowRight as ButtonArrowRight, Undo2 as ButtonUndo2, Check, Wallet, Info, History, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyableField } from "@/components/CopyableField";
import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import { formatUnits, ZeroAddress } from "ethers";
import { OrderBadge } from "@/components/Visuals";
import { useSession } from "@/wallet/session-store";
import { useCommerce, useCommerceAccess, ProtectedAccess, type PublicOrder, type OrderView, type Page } from "./client";
import type { Operation } from "./purchase-journal";
import { OrderSummary, OrderAmount, OrderDialog, eventLabel, OrderTerms, ReceivingIdentities } from "./OrderPresentation";
import { orderPath, orderRole, matchesOrderRole, type OrderRole } from "./order-routes";
import { Sales } from "./Sales";
import { Purchases } from "./Purchases";
import { Fulfillment } from "./Fulfillment";
import { date, Feedback, journal, prepareOperation, randomId, TransactionPanel, useTask, WalletGate } from "./ui";
export function Orders({ role }: { role: "buyer" | "seller" | "arbitrator" }) {
  const access = useCommerceAccess();
  const [query] = useSearchParams();
  if (role === "buyer") return <Purchases />;
  if (role === "seller" && query.get("tab") === "offers") return <Navigate to={`/offers${query.get("filter") ? `?filter=${encodeURIComponent(query.get("filter")!)}` : ""}`} replace />;
  if (role === "seller") return <Sales />;
  return <section className="commerce-page"><h1>Your arbitration cases</h1>
    {!access.address ? <WalletGate /> : <><p className="address">Browsing orders for {access.address}</p><p>No signature is needed to browse. Order history may take time to sync.</p>
      <PublicOrders key={access.address + role} address={access.address} role={role} />
      <ProtectedAccess label="Access saved operations"><PrivateOrders role={role} /></ProtectedAccess>
    </>}
  </section>;
}
function PublicOrders({ address, role }: { address: string; role: "buyer" | "seller" | "arbitrator" }) {
  const api = useCommerce(), task = useTask(), live = useRef(true);
  const [page, setPage] = useState<Page<PublicOrder>>({ items: [], nextCursor: null }), [loaded, setLoaded] = useState(false);
  useEffect(() => { live.current = true; void task.run(() => load()); return () => { live.current = false; }; }, []);
  async function load(after?: string) {
    const result = await api.read<Page<PublicOrder>>(`/public/orders?address=${address.toLowerCase()}&role=${role}${after ? `&after=${after}` : ""}`);
    if (live.current) { setPage(p => ({ ...result, items: after ? [...p.items, ...result.items] : result.items })); setLoaded(true); }
  }
  return <><Button icon={ButtonRefreshCw} iconSpinning={task.busy} variant="secondary" disabled={task.busy} onClick={() => void task.run(() => load())}>Refresh orders</Button><Feedback {...task} busy={task.busy && !loaded} />
    {page.items.map(o => <Link className="card order-card" to={orderPath(o.orderId, role)} key={o.orderId}><h3>#{o.orderId} · {o.offer?.title ?? "Order"}</h3><OrderBadge state={o.order.state} /><p>{o.order.terms.token === ZeroAddress ? `${formatUnits(o.order.terms.price, 18)} MON` : `${o.order.terms.price} base units · ${o.order.terms.token}`}</p><OrderDeadlines order={o} /></Link>)}
    {page.nextCursor && <Button icon={ButtonArrowRight} variant="secondary" disabled={task.busy} onClick={() => void task.run(() => load(page.nextCursor!))}>More orders</Button>}
  </>;
}
function OrderDeadlines({ order: o }: { order: PublicOrder }) {
  return <>{o.order.publicationDeadline !== "0" && <p>Publication deadline: {date(o.order.publicationDeadline)}</p>}{o.order.reviewDeadline !== "0" && <p>Review deadline: {date(o.order.reviewDeadline)}</p>}{o.order.responseDeadline !== "0" && <p>Response deadline: {date(o.order.responseDeadline)}</p>}</>;
}
function CurrentOrderDeadline({ order: o }: { order: { order: Pick<PublicOrder["order"], "state" | "publicationDeadline" | "reviewDeadline" | "responseDeadline"> } }) {
  const { state, publicationDeadline, reviewDeadline, responseDeadline } = o.order;
  const current = state === 2 ? { label: "Complete delivery by", value: publicationDeadline } : state === 3 ? { label: "Review ends", value: reviewDeadline } : state === 4 || state === 5 ? { label: "Reply by", value: responseDeadline } : null;
  return current && current.value !== "0" ? <p>{current.label}: {date(current.value)}</p> : null;
}
function OrderDetailsContent({ order }: { order: PublicOrder["order"] }) {
  return <><OrderAmount token={order.terms.token} price={order.terms.price} /><CopyableField label="Seller wallet" value={order.seller} /><OrderTerms terms={order.terms} /><CurrentOrderDeadline order={{ order }} /></>;
}
function PrivateOrders({ role }: { role: "buyer" | "seller" | "arbitrator" }) {
  const wallet = useSession(), task = useTask();
  const [pending, setPending] = useState<Operation[]>([]);
  useEffect(() => { let live = true; void task.run(async () => {
    const rows = await journal.list(wallet.session!.address);
    if (live) setPending(rows);
  }); return () => { live = false; }; }, [wallet.sessionEpoch, role]);
  return <><Feedback {...task} />
    <h2>Saved operations</h2>{pending.filter(r => role === "buyer" ? !!r.requestId : !r.requestId).map(r => <div className="card" key={r.id}><p>{r.progress === "checking" ? "Checking transaction" : r.progress}</p>{r.productId && <Link to={r.requestId ? `/products/${r.productId}` : `/sales/products/${r.productId}`}>Resume offer operation</Link>}{r.orderId && <Link to={orderPath(r.orderId, role)}>Open order #{r.orderId}</Link>}{r.requestId && <TransactionPanel record={r} onChange={next => setPending(rows => rows.map(row => row.id === next.id ? next : row))} />}</div>)}
</>;
}
export function BuyerOrderPage() { return <OrderPage role="buyer" />; }
export function SellerOrderPage() { return <OrderPage role="seller" />; }
export function ArbitratorOrderPage() { return <OrderPage role="arbitrator" />; }
export function OrderPage({ role }: { role: OrderRole }) {
  const { id } = useParams(), api = useCommerce(), access = useCommerceAccess();
  const [order, setOrder] = useState<PublicOrder>(), [error, setError] = useState(""), [refreshing, setRefreshing] = useState(false);
  const [refundIntent, setRefundIntent] = useState<{ id: string; account: string; kind: "claimRefund" | "claimResponseTimeout" }>();
  const [revision, setRevision] = useState(0), [dialog, setDialog] = useState<"details" | "history">();
  useEffect(() => { let live = true; setOrder(previous => previous?.orderId === id ? previous : undefined); setError(""); setRefreshing(true);
    void api.read<PublicOrder>(`/public/orders/${id}`).then(value => { if (live) setOrder(value); }).catch(e => { if (live) setError(e.message); }).finally(() => { if (live) setRefreshing(false); });
    return () => { live = false; };
  }, [id, revision]);
  const actualRole = order && orderRole(order.order, order.arbitrator, access.address);
  const participant = order && role && matchesOrderRole(role, order.order, order.arbitrator, access.address);
  if (order && actualRole && !participant) return <Navigate to={orderPath(order.orderId, actualRole)} replace />;
  const buyer = order?.order.buyer === access.address?.toLowerCase();
  const refundKind = order && buyer ? publicRefundAction(order) : undefined;
  if (access.authenticated && participant) return <PrivateOrderPage role={role!} key={id + ':' + access.address?.toLowerCase()} publicOffer={order.offer} initialDialog={dialog} initialRefund={refundIntent && refundIntent.id === id && refundIntent.account === access.address?.toLowerCase() ? refundIntent.kind : undefined} onRefundConsumed={() => setRefundIntent(undefined)} />;
  const accessButton = (label: string) => <Button icon={ArrowRight} disabled={access.busy} onClick={() => access.authorize(access.address ?? undefined)}>{label}</Button>;
  return <section className="commerce-page order-detail">{error && <p role="alert">{error}</p>}{!order && !error && <p role="status">Loading order...</p>}{order && <><OrderSummary role={role} view={order} account={access.address ?? undefined} refresh={<Button icon={ButtonRefreshCw} iconSpinning={refreshing} variant="secondary" onClick={() => setRevision(r => r + 1)}>Refresh order</Button>} actions={refundKind ? <Button icon={ButtonUndo2} variant="secondary" disabled={access.busy} onClick={() => { setDialog(undefined); setRefundIntent({ id: id!, account: access.address!.toLowerCase(), kind: refundKind }); access.authorize(access.address!); }}>Claim refund</Button> : participant && order.order.state !== 9 && !(buyer && order.order.state <= 2) ? accessButton(role === "arbitrator" || order.order.state === 6 ? "View case" : role === "seller" && order.order.state === 1 ? "Prepare delivery" : role === "seller" && order.order.state === 2 ? "Continue delivery" : [4, 5].includes(order.order.state) ? "Open conversation" : "Open delivery") : !access.address ? <WalletGate /> : null} tools={<><Button icon={Info} variant="ghost" onClick={() => setDialog("details")}>Order details</Button><Button icon={History} variant="ghost" onClick={() => setDialog("history")}>History</Button></>} />{access.address && role && !participant && <p role="status">This account is not the {role} for this order. Switch accounts to access this view.</p>}{access.error && <p role="alert">{access.error}</p>}
    {dialog && <OrderDialog title={dialog === "details" ? "Order details" : "Order history"} onClose={() => setDialog(undefined)}>{dialog === "details" ? <OrderDetailsContent order={order.order} /> : <><p>Order history is available to the order participants.</p>{participant ? accessButton("View history") : !access.address ? <WalletGate /> : null}{access.error && <p role="alert">{access.error}</p>}</>}</OrderDialog>}
  </>}</section>;


}
export function publicRefundAction(view: PublicOrder): "claimRefund" | "claimResponseTimeout" | undefined {
  const { state, publicationDeadline, responseDeadline } = view.order;
  const now = BigInt(view.block.timestamp);
  if (state === 1 || (state === 2 && (view.canceled || now >= BigInt(publicationDeadline)))) return "claimRefund";
  if (state === 4 && now >= BigInt(responseDeadline)) return "claimResponseTimeout";
  return undefined;
}
function PrivateOrderPage({ role, publicOffer, initialDialog, initialRefund, onRefundConsumed }: { role: OrderRole; publicOffer: PublicOrder["offer"]; initialDialog?: "details" | "history"; initialRefund?: "claimRefund" | "claimResponseTimeout"; onRefundConsumed(): void }) {
  const { id } = useParams(), wallet = useSession(), api = useCommerce(), task = useTask();
  const [dialog, setDialog] = useState(initialDialog), [refreshing, setRefreshing] = useState(false);
  const refundHandled = useRef(false);
  const [confirm, setConfirm] = useState<"claimRefund" | "claimResponseTimeout" | "withdrawSeller" | "confirmReceipt" | "refundDisputedOrder">();
  const [purchaseRecords, setPurchaseRecords] = useState<Operation[]>([]);
  const [order, setOrder] = useState<OrderView>(), [record, setRecord] = useState<Operation>(), [history, setHistory] = useState<Page<{ id: string; name: string; blockNumber: string; transactionHash: string; timestamp?: number | null; data?: Record<string, unknown> }>>({ items: [], nextCursor: null });
  useEffect(() => { setOrder(undefined); setRecord(undefined); setPurchaseRecords([]); setHistory({ items: [], nextCursor: null }); }, [id, wallet.sessionEpoch]);
  useEffect(() => { if (wallet.session && !wallet.session.locked) void task.run(load); }, [id, wallet.sessionEpoch]);
  useEffect(() => {
    if (!wallet.session || wallet.session.locked) return;
    let current = true;
    const timer = window.setInterval(() => { void api.request<OrderView>(`/orders/${id}`).then(value => { if (current) acceptSnapshot(value); }).catch(error => { if (current) task.setError(error.message); }); }, 10000);
    return () => { current = false; clearInterval(timer); };
  }, [id, wallet.sessionEpoch]);
  function acceptSnapshot(current: OrderView) {
    if (!matchesOrderRole(role, current.order, current.assignment?.wallet, wallet.session?.address)) { setOrder(undefined); throw new Error("This account no longer has access to this order view."); }
    setOrder(previous => {
      const fallback = previous?.offer?.title ? previous.offer : publicOffer;
      return !current.offer?.title && fallback ? { ...current, offer: { ...current.offer, title: fallback.title, description: fallback.description, images: fallback.images } } : current;
    });
  }
  async function load() {
    const current = await api.request<OrderView>(`/orders/${id}`); acceptSnapshot(current);
    const [allRows, deployment] = await Promise.all([journal.list(wallet.session!.address), api.read<{ chainId: number; contract: string }>("/deployment")]);
    const rows = allRows.filter(row => row.deployment.chainId === deployment.chainId && row.deployment.contract.toLowerCase() === deployment.contract.toLowerCase());
    setPurchaseRecords(rows.filter(row => row.orderId === id && row.requestId && row.progress === "finalized"));
    setRecord(rows.filter(r => r.orderId === id && !r.requestId && !r.id.startsWith("lifecycle:")).at(-1));
    if (initialRefund && !refundHandled.current) {
      refundHandled.current = true; onRefundConsumed();
      if (!current.eligibility[initialRefund]) task.setError("A refund is no longer available. The order status has changed.");
      else if (rows.some(row => row.orderId === id && row.progress === "checking")) task.setError("Check the pending order transaction before claiming a refund.");
      else { setDialog(undefined); setConfirm(initialRefund); }
    }
    try { setHistory(await api.request(`/orders/${id}/history`)); } catch { task.setError("Order state is verified. History is temporarily unavailable."); }
  }
  async function prepare(kind: "claimRefund" | "claimResponseTimeout" | "withdrawSeller" | "confirmReceipt" | "refundDisputedOrder") {
    if ((await journal.list(wallet.session!.address)).some(r => r.orderId === id && r.progress === "checking")) throw new Error("Recover the pending order transaction first.");
    const current = await api.request<OrderView>(`/orders/${id}`); acceptSnapshot(current);
    if (!current.eligibility[kind]) throw new Error("This action is no longer available.");
    const deployment = await api.read<{ chainId: 10143; contract: string }>("/deployment");
    const next = record && record.progress !== "finalized" ? record : await journal.save({ id: randomId(), account: wallet.session!.address.toLowerCase(), deployment: { chainId: 10143, contract: deployment.contract }, orderId: id, hashes: [], progress: "draft", version: 0 });
    setRecord(await prepareOperation(api, next, { kind, orderId: id! }));
  }
  const isRefund = (kind: string) => kind === "claimRefund" || kind === "refundDisputedOrder" || (kind === "claimResponseTimeout" && role === "buyer");
  const usesSingleApproval = (kind: string) => wallet.session?.kind === "builtin" && (role === "buyer" ? kind === "confirmReceipt" : role === "seller" && ["withdrawSeller", "claimResponseTimeout"].includes(kind));
  function openConfirmation(kind: NonNullable<typeof confirm>) {
    if (task.busy) return;
    setConfirm(kind);
    if (usesSingleApproval(kind) && !(record?.action?.kind === kind && record.progress === "checking")) {
      setRecord(undefined); // Do not expose an old quote while refreshing it.
      void task.run(() => prepare(kind));
    }
  }
  const label = (kind: string) => kind === "confirmReceipt" ? "Accept delivery" : kind === "refundDisputedOrder" ? "Refund buyer" : isRefund(kind) ? "Claim refund" : "Claim payment";
  const reviewRecord = record?.action?.kind === confirm && record?.progress !== "finalized" ? record : undefined;
  const confirmSummary = order && <><OrderAmount token={order.order.terms.token} price={order.order.terms.price} /><p>{confirm === "confirmReceipt" ? "Make the order payment available to the seller." : confirm && label(confirm) === "Claim payment" ? `Claim the order payment, less the order service fee, to ${wallet.session?.address}.` : "Return the full order payment to the buyer."}</p></>;
  const actions = order && <div className="order-actions">{(["refundDisputedOrder", "claimRefund", "claimResponseTimeout", "withdrawSeller"] as const).filter(kind => order.eligibility[kind] && (role === "buyer" ? ["claimRefund", "claimResponseTimeout"].includes(kind) : role === "seller" ? ["refundDisputedOrder", "withdrawSeller", "claimResponseTimeout"].includes(kind) : false)).map(kind => <Button icon={label(kind) === "Claim payment" ? Wallet : ButtonUndo2} key={kind} variant={kind === "refundDisputedOrder" ? "secondary" : "default"} disabled={task.busy || (!!record && record.progress === "checking")} onClick={() => openConfirmation(kind)}>{label(kind)}</Button>)}</div>;
  return <section className="commerce-page order-detail">{!wallet.session ? <WalletGate /> : <>{!order && <p role="status">Loading order...</p>}{order && <>
    <Fulfillment role={role} key={id + ':' + wallet.sessionEpoch} view={order} refresh={async () => acceptSnapshot(await api.request<OrderView>('/orders/' + id))} actions={actions} onAcceptDelivery={role === "buyer" && order.eligibility.confirmReceipt ? () => openConfirmation("confirmReceipt") : undefined} renderSummary={controls => <OrderSummary role={role} view={order} account={wallet.session!.address} refresh={<Button icon={ButtonRefreshCw} iconSpinning={refreshing} variant="secondary" disabled={task.busy} onClick={() => { setRefreshing(true); void task.run(load).finally(() => setRefreshing(false)); }}>Refresh order</Button>} actions={controls} tools={<><Button icon={Info} variant="ghost" onClick={() => setDialog("details")}>Order details</Button><Button icon={History} variant="ghost" onClick={() => setDialog("history")}>History</Button></>} />} renderHistory={completed => dialog === "history" && (<OrderDialog title="Order history" onClose={() => setDialog(undefined)}><p className="muted">Recent activity may take a moment to appear.</p><ol className="order-timeline">{history.items.map(event => <li key={event.id}><strong>{eventLabel(event.name, event.data)}</strong>{event.timestamp && <time dateTime={new Date(event.timestamp * 1000).toISOString()}>{date(String(event.timestamp))}</time>}<details><summary>Transaction details</summary><p>Block {event.blockNumber}</p><p className="address">{event.transactionHash}</p></details></li>)}</ol>{!history.items.length && <p>No activity loaded yet.</p>}{history.nextCursor && <Button icon={ButtonArrowRight} variant="secondary" onClick={() => void task.run(async () => { const next = await api.request<typeof history>('/orders/' + id + '/history?after=' + history.nextCursor); setHistory({ ...next, items: [...history.items, ...next.items] }); })}>More history</Button>}
    <details><summary>Transaction history and technical details</summary>{purchaseRecords.map(purchase => <TransactionPanel key={purchase.id} record={purchase} onChange={() => {}} />)}{record?.progress === "finalized" && <TransactionPanel record={record} onChange={setRecord} />}<p>Verified at finalized block {order.block.number}.</p><ReceivingIdentities order={order.order} />{completed}</details></OrderDialog>)} />
    {record?.action && record.progress !== "finalized" && !confirm && <div className="notice order-refund-recovery" role="status"><strong>{record.progress === "checking" ? "Transaction confirmation pending" : record.progress === "reverted" ? "Transaction did not complete" : "Transaction ready to review"}</strong><p>{record.progress === "checking" ? "Reopen the dialog to check its status." : "Your transaction is saved. Continue when you are ready."}</p><Button onClick={() => setConfirm(record.action!.kind as NonNullable<typeof confirm>)}>{record.progress === "checking" ? isRefund(record.action.kind) ? "Check refund status" : "Check transaction status" : isRefund(record.action.kind) ? "Continue refund" : `Continue ${label(record.action.kind).toLowerCase()}`}</Button></div>}
    {dialog === "details" && <OrderDialog title="Order details" onClose={() => setDialog(undefined)}><OrderDetailsContent order={order.order} /></OrderDialog>}

    {confirm && <OrderDialog title={isRefund(confirm) && reviewRecord ? "Review refund" : label(confirm)} onClose={() => { if (!task.busy) setConfirm(undefined); }}>
      {reviewRecord ? <><TransactionPanel key={reviewRecord.id} record={reviewRecord} singleApproval={usesSingleApproval(confirm)} summary={confirmSummary} confirmLabel={confirm === "confirmReceipt" ? usesSingleApproval(confirm) ? "Confirm acceptance" : "Accept delivery" : isRefund(confirm) ? "Confirm refund" : "Claim payment"} onChange={next => { setRecord(next); if (next.progress === "finalized") setConfirm(undefined); }} onFinalized={load} onRetry={() => prepare(confirm)} compactReview /></> : <><div className="transaction-review-summary">{confirmSummary}<span className="transaction-review-reference">Order #{id}</span></div>{confirm === "confirmReceipt" && <p className="transaction-review-warning">Accepting delivery ends your ability to dispute this order. Continue only if you are satisfied.</p>}<p className="transaction-review-hint">You will review the network fee before confirming the transaction.</p><div className="transaction-review-footer"><Button variant="secondary" disabled={task.busy} onClick={() => setConfirm(undefined)}>Cancel</Button><Button icon={Check} loading={task.busy} onClick={() => void task.run(() => prepare(confirm))}>{usesSingleApproval(confirm) ? confirm === "confirmReceipt" ? "Refresh acceptance" : "Refresh claim" : "Review transaction"}</Button></div></>}<Feedback busy={false} error={task.error} />
    </OrderDialog>}
  </>}</>}<Feedback {...task} busy={task.busy && !refreshing} /></section>;
}
