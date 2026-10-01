import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { ArrowLeft, Clock, Info, X, ShoppingBag, Store, ShieldCheck } from "lucide-react";
import { formatUnits, ZeroAddress } from "ethers";
import { CopyableField } from "@/components/CopyableField";
import { Button } from "@/components/ui/button";
import { tokenPresentation } from "@/config/token-icons";
import { useCommerce, type OrderView, type PublicOrder, type Terms } from "./client";
import type { OrderRole } from "./order-routes";
import { purchaseStatus } from "./Purchases";
import { OfferCover } from "./OfferImages";
import { orderStatusTone } from "./order-status-tone";
import { date } from "./ui";
import { TransactionDialogContext } from "./transaction-dialog-context";
type Summary = Pick<OrderView, "orderId" | "block" | "canceled"> & { order: PublicOrder["order"]; offer: { title?: string; description?: string; images?: OrderView["offer"]["images"] } | null };
export function OrderAmount({ token, price }: { token: string; price: string }) {
  const api = useCommerce(), [asset, setAsset] = useState<{ symbol: string; decimals: number } | null>();
  useEffect(() => { let live = true; setAsset(undefined); if (token === ZeroAddress) setAsset({ symbol: "MON", decimals: 18 }); else void api.read<{ symbol: string; decimals: number }>(`/public/assets/${token}`).then(a => { if (live) setAsset(Number.isInteger(a.decimals) && a.decimals >= 0 && a.decimals <= 80 ? a : null); }).catch(() => { if (live) setAsset(null); }); return () => { live = false; }; }, [token]);
  const presentation = tokenPresentation(10143, token), Icon = presentation.icon;
  return <span className="purchase-price">{presentation.iconUrl ? <img src={presentation.iconUrl} alt="" width={26} height={26} /> : <Icon size={26} aria-hidden="true" />}<span>{asset ? `${formatUnits(price, asset.decimals).replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1")} ${asset.symbol}` : asset === null ? "Amount unavailable" : "Loading amount..."}</span></span>;
}
export function orderNext(view: Summary, account?: string) {
  const o = view.order, seller = account?.toLowerCase() === o.seller, buyer = account?.toLowerCase() === o.buyer;
  const now = BigInt(view.block.timestamp);
  if (o.state === 2 && (view.canceled || now >= BigInt(o.publicationDeadline))) return "Delivery publication did not finish in time or the offer was canceled. The buyer can claim a refund.";
  if (o.state === 3 && now >= BigInt(o.reviewDeadline)) return "The review period has ended. The seller can now claim payment.";
  if ([4, 5].includes(o.state) && now >= BigInt(o.responseDeadline)) return o.state === 4 ? "The seller's response window ended. The buyer can claim a refund." : "The buyer's response window ended. The seller can claim payment.";
  switch (o.state) {
    case 1: return view.canceled ? "This offer was canceled. The buyer can claim a refund." : seller ? "Prepare the content for your buyer, review it, then send your delivery." : "Waiting for the seller to deliver. The buyer can claim a refund before delivery is committed.";
    case 2: return "Delivery is being published. If publication expires or the offer is canceled, the buyer can claim a refund. Refresh to check availability.";
    case 3: return buyer ? "Open and review your delivery below. Accept it when satisfied, or report a problem before the review deadline. After the deadline, the seller can claim payment." : "The buyer can review the delivery. Payment becomes claimable after the review deadline, unless a dispute is opened.";
    case 4: case 5: return (o.state === 4 ? seller : buyer) ? "Your response is needed. Reply before the deadline; after it, the other participant can claim the funds." : "Waiting for the other participant to respond. After the deadline, you may be able to claim the funds.";
    case 6: return "The arbitrator will decide the outcome. Open the case to review requests and provide evidence.";
    case 7: return seller ? "The buyer accepted delivery. Claim your payment below." : "Delivery was accepted. The seller can now claim payment.";
    case 8: return "This order is complete and payment has been released to the seller.";
    case 9: return "This order has been refunded to the buyer.";
    default: return "Refresh to check this order's status.";
  }
}
export function OrderSummary({ view, account, refresh, actions, tools, role }: { role?: OrderRole; view: Summary; account?: string; refresh: ReactNode; actions?: ReactNode; tools?: ReactNode }) {
  const seller = account?.toLowerCase() === view.order.seller, buyer = account?.toLowerCase() === view.order.buyer;
  const backRole = role ?? (seller ? "seller" : buyer || !account ? "buyer" : "arbitrator");
  const status = purchaseStatus(view as PublicOrder);
  const needsDelivery = seller && view.order.state === 1 && !view.canceled;
  const label = needsDelivery ? "Needs delivery" : seller && status.deadline ? view.order.state === 5 ? "Awaiting buyer response" : view.order.state === 4 ? "Your response needed" : view.order.state === 3 ? "Buyer reviewing delivery" : status.label : status.label;
  const [pinned, setPinned] = useState(false), [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false), [dismissed, setDismissed] = useState(false);
  const helpId = useId(), statusRef = useRef<HTMLDivElement>(null);
  const helpOpen = !dismissed && (pinned || hovered || focused);
  useEffect(() => { const close = (e: PointerEvent) => { if (!statusRef.current?.contains(e.target as Node)) { setPinned(false); setFocused(false); setHovered(false); } }; document.addEventListener("pointerdown", close); return () => document.removeEventListener("pointerdown", close); }, []);
  const tone = orderStatusTone(view.order.state, !!needsDelivery || label === "Your response needed" || !!(buyer && status.attention));
  return <><div className="section-heading"><Button asChild variant="ghost"><Link to={backRole === "seller" ? "/sales" : backRole === "buyer" ? "/purchases" : "/arbitration"}><ArrowLeft />Back to {backRole === "seller" ? "orders" : backRole === "buyer" ? "purchases" : "cases"}</Link></Button>{refresh}</div>
    <header className="card order-summary"><div className="order-top-row"><p className="muted">Order #{view.orderId}</p><div ref={statusRef} className="order-status-help" onMouseEnter={() => { setHovered(true); setDismissed(false); }} onMouseLeave={() => setHovered(false)} onKeyDown={e => { if (e.key === "Escape") { setPinned(false); setDismissed(true); e.stopPropagation(); } }}><Button icon={Info} className={'order-status-pill status-' + tone} variant="secondary" aria-label={'Status: ' + label} aria-expanded={helpOpen} aria-describedby={helpOpen ? helpId : undefined} onFocus={() => { setFocused(true); setDismissed(false); }} onBlur={() => setFocused(false)} onClick={() => { setPinned(!pinned); setDismissed(pinned); }}>{label}</Button>{helpOpen && <div className="order-status-tooltip" role="tooltip" id={helpId}>{orderNext(view, account)}</div>}</div></div><div className="order-summary-product">{!!view.offer?.images?.length && <OfferCover images={view.offer.images} title={view.offer.title ?? "Purchased offer"} />}<div className="order-summary-product-copy"><div className="offer-review-heading"><h1>{view.offer?.title ?? "Purchased offer"}</h1><OrderAmount token={view.order.terms.token} price={view.order.terms.price} /></div>{view.offer?.description && <p className="description">{view.offer.description}</p>}</div></div>{seller && <div className="order-summary-buyer"><ShoppingBag size={16} aria-hidden="true" /><CopyableField label="Buyer" value={view.order.buyer} displayValue={view.order.buyer.slice(0, 6) + "..." + view.order.buyer.slice(-4)} /></div>}{status.deadline && <p className="purchase-deadline"><Clock size={15} />{status.deadlineLabel}: {date(status.deadline)}</p>}<div className="order-card-footer"><div className="order-card-actions">{actions}</div><div className="order-card-tools">{tools}</div></div></header></>;
}
export function OrderDialog({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null), id = useId();
  const [busy, setBusy] = useState(false);
  const close = () => { if (!busy) onClose(); };
  useEffect(() => { const d = ref.current; d?.showModal(); return () => d?.close(); }, []);
  return createPortal(<dialog ref={ref} className="approval-dialog wallet-action-dialog order-dialog" aria-labelledby={id} onCancel={e => { e.preventDefault(); close(); }}><div className="section-heading"><h2 id={id}>{title}</h2><Button icon={X} size="icon" variant="ghost" aria-label="Close dialog" disabled={busy} onClick={close} /></div><TransactionDialogContext.Provider value={{ close, setBusy }}>{children}</TransactionDialogContext.Provider></dialog>, document.body);
}
export function eventLabel(name: string, data?: Record<string, unknown>) {
  if (name === "RecordPublished") return String(data?.sequence) === "0" ? "Delivery published" : "Message sent";
  if (name === "Settled") return Number(data?.state) === 9 ? "Buyer refunded" : "Seller paid";
  if (name === "StateChanged") return ({ 1: "Purchased", 2: "Publication started", 3: "Delivery ready for review", 4: "Seller response requested", 5: "Buyer response requested", 6: "Arbitration opened", 7: "Delivery accepted", 8: "Payment released", 9: "Order refunded" } as Record<number, string>)[Number(data?.state)] ?? "Order status updated";
  const labels: Record<string, string> = { Purchased: "Purchased", DeliveryReserved: "Delivery publication started", ArbitrationAssigned: "Arbitrator assigned", EvidencePublished: "Evidence submitted", EvidenceRequested: "Evidence requested" };
  return labels[name] ?? name.replace(/([a-z])([A-Z])/g, "$1 $2");
}
export function OrderTerms({ terms }: { terms: Terms }) {
  const duration = (value: string) => { const n = BigInt(value); const amount = (unit: bigint, label: string) => `${n / unit} ${label}${n / unit === 1n ? "" : "s"}`; return n > 0n && n % 86400n === 0n ? amount(86400n, "day") : n > 0n && n % 3600n === 0n ? amount(3600n, "hour") : n > 0n && n % 60n === 0n ? amount(60n, "minute") : amount(1n, "second"); };
  return <><dl className="terms">{terms.hasEventEnd && <><dt>Event end</dt><dd>{date(terms.eventEnd)}</dd></>}<dt>Review period</dt><dd>{duration(terms.reviewWindow)} after delivery{terms.hasEventEnd ? " or event end, whichever is later" : ""}</dd></dl><p>Check the delivery before accepting it. If something is wrong, report a problem during the review period. Accepting ends your review and lets the seller claim payment.</p></>;
}

export function ReceivingIdentities({ order }: { order: OrderView["order"] }) {
  const shorten = (value: string) => value.length > 26 ? value.slice(0, 12) + "..." + value.slice(-10) : value;
  return <details className="receiving-identities"><summary><ShieldCheck size={17} aria-hidden="true" />Receiving identities</summary><p className="muted">Public encryption details saved with this order. They identify the keys used to open its private content.</p><div className="receiving-identity-grid">{(["buyer", "seller"] as const).map(role => {
    const identity = order[role === "buyer" ? "buyerReceiving" : "sellerReceiving"], Icon = role === "buyer" ? ShoppingBag : Store, label = role === "buyer" ? "Buyer" : "Seller";
    return <section className="receiving-identity-card" key={role} aria-label={label + " receiving identity"}><h3><Icon size={18} aria-hidden="true" />{label}</h3><CopyableField label={label + " public key"} value={identity.publicKey} displayValue={shorten(identity.publicKey)} /><CopyableField label={label + " key reference"} value={identity.nonce} displayValue={shorten(identity.nonce)} /></section>;
  })}</div><p className="receiving-identity-note">These are public identifiers, not private keys. Copying a value copies the full identifier.</p></details>;
}
