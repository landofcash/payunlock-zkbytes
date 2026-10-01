import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, CheckCircle2, Clock, Info, Package, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyableField } from "@/components/CopyableField";
import { useCommerce, useCommerceAccess, type PublicOrder, type Page } from "./client";
import { OrderAmount } from "./OrderPresentation";
import { OfferCover, useOfferDetails } from "./OfferImages";
import { orderPath } from "./order-routes";
import { date, Feedback, journal, useTask, WalletGate } from "./ui";
import type { Operation } from "./purchase-journal";

type Status = { label: string; explanation: string; action?: string; attention?: boolean; delivery?: boolean; completed?: boolean; deadline?: string; deadlineLabel?: string; tone: "waiting" | "attention" | "completed" | "refunded" };
export function sellerOrderStatus(view: PublicOrder): Status {
  const o = view.order, now = BigInt(view.block.timestamp);
  if ((o.state === 1 && view.canceled) || (o.state === 2 && (view.canceled || now >= BigInt(o.publicationDeadline)))) return { label: "Buyer refund available", explanation: "The buyer can claim a refund. This order can no longer be delivered.", tone: "waiting" };
  if (o.state === 1) return { label: "Needs delivery", explanation: "Prepare and review the buyer's content, then publish delivery.", action: "Prepare delivery", attention: true, delivery: true, tone: "attention" };
  if (o.state === 2) return { label: "Finish publication", explanation: "Publish before the deadline to complete delivery. After it, the buyer can claim a refund.", action: "Continue delivery", attention: true, delivery: true, tone: "attention", deadline: o.publicationDeadline, deadlineLabel: "Publish by" };
  if (o.state === 7 || (o.state === 3 && now >= BigInt(o.reviewDeadline)) || (o.state === 5 && now >= BigInt(o.responseDeadline))) return { label: "Payment available", explanation: "You can claim the order payment. Funds are not transferred automatically.", action: "Claim payment", attention: true, tone: "attention" };
  if (o.state === 3) return { label: "Buyer reviewing", explanation: "The buyer is reviewing delivery. Payment becomes claimable after the review deadline unless a dispute is opened.", tone: "waiting", deadline: o.reviewDeadline, deadlineLabel: "Review ends" };
  if (o.state === 4) return now >= BigInt(o.responseDeadline) ? { label: "Response window ended", explanation: "Your response deadline passed. The buyer can now claim a refund.", tone: "waiting" } : { label: "Your response needed", explanation: "Reply to the buyer before the deadline. After it, they can claim a refund.", action: "Reply", attention: true, tone: "attention", deadline: o.responseDeadline, deadlineLabel: "Reply by" };
  if (o.state === 5) return { label: "Awaiting buyer response", explanation: "The buyer must respond before the deadline. After it, you can claim payment.", tone: "waiting", deadline: o.responseDeadline, deadlineLabel: "Buyer response due" };
  if (o.state === 6) return { label: "In arbitration", explanation: "Review the case for evidence requests. The arbitrator decides the outcome.", action: "View case", tone: "waiting" };
  if (o.state === 8) return { label: "Completed", explanation: "The order payment has been released to the seller.", completed: true, tone: "completed" };
  if (o.state === 9) return { label: "Refunded", explanation: "The order payment has been returned to the buyer.", completed: true, tone: "refunded" };
  return { label: "Status unavailable", explanation: "Refresh to check the current order status.", tone: "waiting" };
}
function StatusHelp({ status }: { status: Status }) {
  const helpId = useId();
  const [open, setOpen] = useState(false), ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const close = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); }; document.addEventListener("pointerdown", close); return () => document.removeEventListener("pointerdown", close); }, []);
  return <div ref={ref} className="order-status-help" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onKeyDown={e => { if (e.key === "Escape") setOpen(false); }}><Button icon={Info} variant="secondary" className={'order-status-pill status-' + status.tone} aria-expanded={open} aria-describedby={open ? helpId : undefined} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onClick={() => setOpen(true)}>{status.label}</Button>{open && <div className="order-status-tooltip" role="tooltip" id={helpId}>{status.explanation}</div>}</div>;
}
export function Sales() {
  const access = useCommerceAccess();
  return access.address ? <SellerOrders key={access.address.toLowerCase()} address={access.address.toLowerCase()} /> : <section className="commerce-page"><h1>Your orders</h1><WalletGate /></section>;
}
function SellerOrders({ address }: { address: string }) {
  const api = useCommerce(), task = useTask(), live = useRef(true);
  const [page, setPage] = useState<Page<PublicOrder>>({ items: [], nextCursor: null }), [loaded, setLoaded] = useState(false), [filter, setFilter] = useState("all");
  const [unfinished, setUnfinished] = useState<Operation[]>([]), [recoveryError, setRecoveryError] = useState("");
  async function load(after?: string) {
    const result = await api.read<Page<PublicOrder>>(`/public/orders?address=${address}&role=seller${after ? '&after=' + after : ''}`);
    if (live.current) { setPage(previous => ({ ...result, items: after ? [...new Map([...previous.items, ...result.items].map(item => [item.orderId, item])).values()] : result.items })); setLoaded(true); }
  }
  async function loadRecovery() {
    try {
      const [rows, deployment] = await Promise.all([journal.list(address), api.read<{ chainId: number; contract: string }>("/deployment")]);
      const latest = new Map<string, Operation>();
      for (const row of rows) if (row.orderId && !row.requestId && row.deployment.chainId === deployment.chainId && row.deployment.contract.toLowerCase() === deployment.contract.toLowerCase()) {
        const previous = latest.get(row.orderId); if (previous?.progress !== "checking" || row.progress === "checking") latest.set(row.orderId, row);
      }
      const candidates = [...latest.values()].filter(row => row.progress !== "finalized");
      const verified = await Promise.all(candidates.map(async row => { const view = await api.read<PublicOrder>(`/public/orders/${row.orderId}`); return view.order.seller.toLowerCase() === address && (view.order.state < 8 || row.progress === "checking") ? row : undefined; }));
      if (live.current) { setUnfinished(verified.filter((row): row is Operation => !!row)); setRecoveryError(""); }
    } catch { if (live.current) setRecoveryError("Unfinished work could not be loaded. Refresh to try again."); }
  }
  useEffect(() => { live.current = true; void task.run(() => load()); void loadRecovery(); return () => { live.current = false; }; }, [address]);
  const offerDetails = useOfferDetails(page.items.map(order => order.offer?.id));
  const shown = page.items.filter(order => { const status = sellerOrderStatus(order); return filter === "all" || (filter === "delivery" ? status.delivery : filter === "attention" ? status.attention : status.completed); });
  const indexed = new Set(page.items.map(order => order.orderId));
  return <section className="commerce-page purchases-page seller-orders"><div className="section-heading"><h1>Your orders</h1><Button icon={RefreshCw} iconSpinning={task.busy} variant="secondary" disabled={task.busy} onClick={() => void task.run(async () => { await Promise.all([load(), loadRecovery()]); })}>Refresh</Button></div><div className="purchase-account"><CopyableField label="Account" value={address} displayValue={address.slice(0, 6) + '...' + address.slice(-4)} /></div>
    <div className="purchase-filters" role="group" aria-label="Filter orders">{([["all", "All"], ["delivery", "Needs delivery"], ["attention", "Needs attention"], ["completed", "Completed"]] as const).map(([value, label]) => <Button key={value} icon={value === "completed" ? CheckCircle2 : value === "attention" ? Clock : Package} variant={filter === value ? "default" : "ghost"} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</Button>)}</div>
    {page.indexing?.status === "syncing" && <p role="status">Order history is syncing. Recent orders may take a moment to appear.</p>}{page.indexing?.status === "unavailable" && <p role="status">Order history is temporarily unavailable. Recent orders may be missing.</p>}<Feedback {...task} busy={task.busy && !loaded} />
    <div className="purchase-list">{shown.map(order => { const status = sellerOrderStatus(order), saved = unfinished.find(row => row.orderId === order.orderId), path = orderPath(order.orderId, "seller"); return <article className="card purchase-card" key={order.orderId}>
      <OfferCover images={order.offer ? offerDetails[order.offer.id]?.images ?? [] : []} title={order.offer?.title ?? "Order"} />
      <div className="purchase-card-main">
        <h2><Link to={path}>{order.offer?.title ?? "Order"}</Link></h2>
        <p className="purchase-number">Order #{order.orderId}</p>
        <div className="seller-order-buyer"><CopyableField label="Buyer" value={order.order.buyer} displayValue={order.order.buyer.slice(0, 6) + '...' + order.order.buyer.slice(-4)} /></div>
        {status.deadline && status.deadline !== "0" && <p className="purchase-deadline"><Clock size={14} />{status.deadlineLabel}: {date(status.deadline)}</p>}
      </div>
      <div className="purchase-card-side">
        <StatusHelp status={status} />
        <div className="purchase-card-side-bottom">
          <OrderAmount token={order.order.terms.token} price={order.order.terms.price} />
          <div className="order-card-actions">{(saved || status.action) && <Button asChild><Link to={path}><ArrowRight />{saved ? saved.progress === "checking" ? "Check status" : "Continue unfinished work" : status.action}</Link></Button>}<Button asChild variant="secondary"><Link to={path} aria-label={'Open order #' + order.orderId}><ArrowRight />Open order</Link></Button></div>
        </div>
      </div>
    </article>; })}</div>
    {loaded && !shown.length && <div className="empty-state"><Package size={28} /><h2>{filter === "all" && !page.items.length ? "No orders yet" : "No matching orders"}</h2><p>{page.nextCursor ? "Load more orders to see additional results." : filter === "all" ? "Buyer purchases will appear here." : "Try another filter to see your orders."}</p></div>}
    {page.nextCursor && <Button icon={ArrowRight} variant="secondary" disabled={task.busy} onClick={() => void task.run(() => load(page.nextCursor!))}>More orders</Button>}{recoveryError && <p role="status">{recoveryError}</p>}
    {unfinished.some(row => !indexed.has(row.orderId!)) && <section className="unfinished-purchases"><h2>Unfinished work</h2>{unfinished.filter(row => !indexed.has(row.orderId!)).map(row => <article className="card purchase-recovery" key={row.id}><div><h3>Order #{row.orderId}</h3><p>{row.progress === "checking" ? "Confirm the transaction status before trying again." : "Continue from your saved operation."}</p></div><Button asChild variant="secondary"><Link to={orderPath(row.orderId!, "seller")}><ArrowRight />{row.progress === "checking" ? "Check status" : "Continue unfinished work"}</Link></Button></article>)}</section>}
  </section>;
}
