import {useEffect, useId, useRef, useState} from "react";
import {Link} from "react-router-dom";
import {ArrowRight, CheckCircle2, Clock, Compass, RefreshCw, ShoppingBag, Trash2, X} from "lucide-react";
import {formatUnits, ZeroAddress} from "ethers";
import {Button} from "@/components/ui/button";
import {CopyableField} from "@/components/CopyableField";
import {tokenPresentation} from "@/config/token-icons";
import {type Page, type PublicOrder, useCommerce, useCommerceAccess} from "./client";
import {OfferCover, useOfferDetails} from "./OfferImages";
import {orderStatusTone} from "./order-status-tone";
import type {Operation} from "./purchase-journal";
import {date, Feedback, journal, useTask, WalletGate} from "./ui";

type Filter = "all" | "active" | "attention" | "completed";
type Token = { symbol: string; decimals: number };

export function purchaseStatus(order: PublicOrder) {
  const {state, publicationDeadline, reviewDeadline, responseDeadline} = order.order;
  const now = BigInt(order.block.timestamp), publicationExpired = now >= BigInt(publicationDeadline),
    reviewExpired = now >= BigInt(reviewDeadline), responseExpired = now >= BigInt(responseDeadline);
  if ((state === 1 && order.canceled) || (state === 2 && (order.canceled || publicationExpired))) return {
    label: "Refund available",
    attention: true
  };
  switch (state) {
    case 1:
      return {label: "Awaiting delivery", attention: false};
    case 2:
      return {
        label: "Delivery being published",
        attention: false,
        deadline: publicationDeadline,
        deadlineLabel: "Publication due"
      };
    case 3:
      return reviewExpired ? {label: "Review period ended", attention: false} : {
        label: "Delivered",
        attention: true,
        deadline: reviewDeadline,
        deadlineLabel: "Review by"
      };
    case 4:
      return responseExpired ? {label: "Seller response overdue", attention: true} : {
        label: "Awaiting seller response",
        attention: false,
        deadline: responseDeadline,
        deadlineLabel: "Seller response due"
      };
    case 5:
      return responseExpired ? {label: "Response window ended", attention: false} : {
        label: "Your response needed",
        attention: true,
        deadline: responseDeadline,
        deadlineLabel: "Respond by"
      };
    case 6:
      return {label: "In arbitration", attention: false};
    case 7:
    case 8:
      return {label: "Completed", attention: false};
    case 9:
      return {label: "Refunded", attention: false};
    default:
      return {label: "Status unavailable", attention: false};
  }
}

export function Purchases() {
  const access = useCommerceAccess();
  return !access.address ? <section className="commerce-page"><h1>Your purchases</h1><WalletGate/></section> :
    <PurchaseList key={access.address.toLowerCase()} address={access.address}/>;
}

function RemoveCheckoutDialog({title, busy, error, onClose, onRemove}: {
  title: string;
  busy: boolean;
  error: string;
  onClose(): void;
  onRemove(): void
}) {
  const dialog = useRef<HTMLDialogElement>(null), titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className="approval-dialog wallet-action-dialog" aria-labelledby={titleId}
                 onCancel={event => {
                   event.preventDefault();
                   if (!busy) onClose();
                 }}>
    <div className="section-heading"><h2 id={titleId}>Remove saved checkout?</h2><Button icon={X} size="icon"
                                                                                         variant="ghost"
                                                                                         aria-label="Close dialog"
                                                                                         disabled={busy}
                                                                                         onClick={onClose}/></div>
    <p>Remove the saved checkout for <strong>{title}</strong> from this device? This does not cancel a payment or an
      order.</p>
    <div className="dialog-actions"><Button variant="secondary" disabled={busy} onClick={onClose}>Keep checkout</Button><Button
      icon={Trash2} variant="destructive" disabled={busy} onClick={onRemove}>Remove checkout</Button></div>
    <Feedback busy={busy} error={error}/>
  </dialog>;
}

function PurchaseList({address}: { address: string }) {
  const api = useCommerce(), task = useTask(), live = useRef(true);
  const [page, setPage] = useState<Page<PublicOrder>>({
    items: [],
    nextCursor: null
  }), [loaded, setLoaded] = useState(false), [filter, setFilter] = useState<Filter>("all");
  const [records, setRecords] = useState<Operation[]>([]), [recoveryError, setRecoveryError] = useState("");
  const [removeTarget, setRemoveTarget] = useState<{ record: Operation; title: string } | null>(null);
  const [tokens, setTokens] = useState<Record<string, Token | null>>({[ZeroAddress]: {symbol: "MON", decimals: 18}});

  async function load(after?: string) {
    const result = await api.read<Page<PublicOrder>>(`/public/orders?address=${address.toLowerCase()}&role=buyer${after ? `&after=${after}` : ""}`);
    if (live.current) {
      setPage(previous => ({
        ...result,
        items: after ? [...new Map([...previous.items, ...result.items].map(item => [item.orderId, item])).values()] : result.items
      }));
      setLoaded(true);
    }
  }

  async function loadRecords() {
    try {
      const [rows, deployment] = await Promise.all([journal.list(address), api.read<{
        chainId: number;
        contract: string
      }>("/deployment")]);
      if (live.current) {
        setRecords(rows.filter(row => row.requestId && row.deployment.chainId === deployment.chainId && row.deployment.contract.toLowerCase() === deployment.contract.toLowerCase()));
        setRecoveryError("");
      }
    } catch {
      if (live.current) setRecoveryError("Unfinished purchases could not be loaded. Refresh to try again.");
    }
  }

  useEffect(() => {
    live.current = true;
    void task.run(() => load());
    void loadRecords();
    return () => {
      live.current = false;
    };
  }, [address]);
  const offerDetails = useOfferDetails([...page.items.map(order => order.offer?.id), ...records.filter(record => record.progress !== "finalized").map(record => record.productId)]);
  const tokenKey = [...new Set(page.items.map(order => order.order.terms.token.toLowerCase()))].sort().join(",");
  useEffect(() => {
    let current = true;
    const missing = tokenKey.split(",").filter(token => token && tokens[token] === undefined);
    void Promise.all(missing.map(async token => {
      try {
        const value = await api.read<Token>(`/public/assets/${token}`);
        return [token, Number.isInteger(value.decimals) && value.decimals >= 0 && value.decimals <= 80 ? value : null] as const;
      } catch {
        return [token, null] as const;
      }
    })).then(entries => {
      if (current && entries.length) setTokens(previous => ({...previous, ...Object.fromEntries(entries)}));
    });
    return () => {
      current = false;
    };
  }, [tokenKey, loaded]);
  const shown = page.items.filter(order => filter === "all" || (filter === "completed" ? order.order.state >= 7 : filter === "active" ? order.order.state > 0 && order.order.state < 7 : purchaseStatus(order).attention));
  const indexed = new Set(page.items.map(order => order.orderId));
  const unfinished = records.filter(record => record.progress !== "finalized" && (!record.orderId || !indexed.has(record.orderId)));
  const confirmed = records.filter(record => record.progress === "finalized" && record.orderId && !indexed.has(record.orderId));
  const syncing = page.indexing?.status === "syncing" || page.indexing?.status === "unavailable";
  return <section className="commerce-page purchases-page">
    <div className="section-heading"><h1>Your purchases</h1><Button icon={RefreshCw}
                                                                    iconSpinning={task.busy && !removeTarget}
                                                                    variant="secondary" disabled={task.busy}
                                                                    onClick={() => void task.run(async () => {
                                                                      await Promise.all([load(), loadRecords()]);
                                                                    })}>Refresh</Button></div>
    <div className="purchase-account"><CopyableField label="Account" value={address}
                                                     displayValue={`${address.slice(0, 6)}...${address.slice(-4)}`}/>
    </div>
    <div className="purchase-filters" role="group"
         aria-label="Filter purchases">{([["all", "All"], ["active", "Active"], ["attention", "Needs attention"], ["completed", "Completed"]] as const).map(([value, label]) =>
      <Button key={value} icon={value === "attention" ? Clock : value === "completed" ? CheckCircle2 : ShoppingBag}
              variant={filter === value ? "default" : "ghost"} aria-pressed={filter === value}
              onClick={() => setFilter(value)}>{label}</Button>)}</div>
    {syncing && <p className="muted"
                   role="status">{page.indexing?.status === "unavailable" ? "Order history is temporarily unavailable. Recent purchases may be missing." : "Order history is syncing. Recent purchases may take a moment to appear."}</p>}
    <Feedback {...task} busy={task.busy && !loaded}/>
    <div className="purchase-list">{shown.map(order => {
      const status = purchaseStatus(order), token = order.order.terms.token.toLowerCase(), metadata = tokens[token],
        presentation = tokenPresentation(10143, token), Icon = presentation.icon;
      return <article className="card purchase-card" key={order.orderId}>
        <OfferCover images={order.offer ? offerDetails[order.offer.id]?.images ?? [] : []}
                    title={order.offer?.title ?? "Purchase"}/>
        <div className="purchase-card-main">
          <h2><Link to={`/purchases/${order.orderId}`}>{order.offer?.title ?? "Purchase"}</Link></h2>
          <p className="purchase-number">Order #{order.orderId}</p>
          {status.deadline && status.deadline !== "0" && <p className="purchase-deadline"><Clock size={14}
                                                                                                 aria-hidden="true"/>{status.deadlineLabel}: {date(status.deadline)}
          </p>}
        </div>
        <div className="purchase-card-side">
          <span
            className={`order-badge status-${orderStatusTone(order.order.state, status.attention)}`}>{status.label}</span>
          <div className="purchase-card-side-bottom">
            <div className="purchase-price" title={token === ZeroAddress ? "Native MON" : token}>{presentation.iconUrl ?
              <img src={presentation.iconUrl} alt="" width={24} height={24}/> : <Icon size={24}
                                                                                      aria-hidden="true"/>}<span>{metadata ? `${formatUnits(order.order.terms.price, metadata.decimals).replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1")} ${metadata.symbol}` : metadata === null ? "Amount unavailable" : "Loading amount..."}</span>
            </div>
            <Button asChild variant="secondary"><Link to={`/purchases/${order.orderId}`}
                                                      aria-label={`Open order #${order.orderId}`}>Open order<ArrowRight
              aria-hidden="true"/></Link></Button>
          </div>
        </div>
      </article>;
    })}</div>
    {loaded && !shown.length && <div className="empty-state"><ShoppingBag size={28} aria-hidden="true"/>
        <h2>{page.items.length || filter !== "all" ? "No matching purchases" : "No purchases yet"}</h2>
        <p>{page.nextCursor ? "Load more purchases to see additional results." : filter === "all" ? "Your purchases will appear here after you place an order." : "Try another filter to see your purchases."}</p>{filter === "all" && !page.nextCursor &&
            <Button asChild variant="secondary"><Link to="/discover"><Compass aria-hidden="true"/>Explore offers</Link></Button>}
    </div>}
    {page.nextCursor && <Button icon={ArrowRight} variant="secondary" disabled={task.busy}
                                onClick={() => void task.run(() => load(page.nextCursor!))}>More purchases</Button>}
    {recoveryError && <p role="status">{recoveryError}</p>}
    {!!unfinished.length &&
        <section className="unfinished-purchases"><h2>Unfinished purchases</h2>{unfinished.map(record => {
          const offer = record.productId ? offerDetails[record.productId] : null;
          const title = offer?.title ?? (record.productId ? offer === undefined ? "Loading offer..." : "Offer unavailable" : "Saved checkout");
          return <article className="card purchase-recovery" key={record.id}>
            <div className="purchase-recovery-body"><OfferCover images={offer?.images ?? []} title={title}/>
              <div><h3>{title}</h3><p
                className="purchase-recovery-status">{record.progress === "checking" ? "Checking transaction" : record.progress === "reverted" ? "Payment needs another review" : "Checkout not finished"}</p>
                <p>{record.progress === "checking" ? "Check payment status before removing this checkout." : "Continue from where you left off."}</p>
              </div>
            </div>
            <div className="purchase-recovery-actions">{record.productId &&
                <Button asChild variant="secondary"><Link to={`/products/${record.productId}`} state={{
                  checkout: true,
                  resumeId: record.id
                }}><ArrowRight/>{record.progress === "checking" ? "Check status" : "Continue checkout"}</Link></Button>}<Button
              icon={Trash2} variant="ghost" className="purchase-recovery-remove"
              aria-label={`Remove checkout for ${title}`}
              title={record.progress === "checking" ? "Check payment status before removing" : undefined}
              disabled={record.progress === "checking" || !!record.orderId || offer === undefined || task.busy}
              onClick={() => {
                task.setError("");
                setRemoveTarget({record, title});
              }}>Remove</Button></div>
          </article>;
        })}</section>}
    {!!confirmed.length &&
        <section className="recent-purchases"><h2>Confirmed purchases</h2>{confirmed.map(record => <article
          className="card purchase-recovery" key={record.id}>
          <div><h3><CheckCircle2 size={18} aria-hidden="true"/>Order #{record.orderId} confirmed</h3><p>Your purchase is
            confirmed. Open it directly.</p></div>
          <Button asChild variant="secondary"><Link to={`/purchases/${record.orderId}`}><ArrowRight/>Open
            order</Link></Button></article>)}</section>}
    {removeTarget &&
        <RemoveCheckoutDialog title={removeTarget.title} busy={task.busy} error={task.error} onClose={() => {
          setRemoveTarget(null);
          task.setError("");
        }} onRemove={() => void task.run(async () => {
          await journal.remove(removeTarget.record);
          setRecords(rows => rows.filter(row => row.id !== removeTarget.record.id));
          setRemoveTarget(null);
        })}/>}
  </section>;
}
