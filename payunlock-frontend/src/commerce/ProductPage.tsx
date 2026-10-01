import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, Check, CheckCircle2, RefreshCw, ShoppingBag } from "lucide-react";
import { formatUnits, hexlify } from "ethers";
import { decodeBase64 } from "@zkbytes/sdk";
import { Button } from "@/components/ui/button";
import { Confetti, type ConfettiRef } from "@/components/ui/confetti";
import { useSession } from "@/wallet/session-store";
import { TopUpDialog } from "@/wallet/TopUpDialog";
import { tokenPresentation } from "@/config/token-icons";
import { useCommerce, useCommerceAccess, type Asset, type Configuration, type Deployment, type Product } from "./client";
import { OfferReview } from "./OfferReview";
import { PaymentBalance } from "./PaymentBalance";
import { newReceivingContext, restoreReceiving } from "./protocol";
import type { Operation } from "./purchase-journal";
import { Feedback, journal, native, prepareOperation, randomId, TransactionPanel, useTask } from "./ui";
import { OfferGallery } from "./OfferImages";
import { OrderDialog } from "./OrderPresentation";
import { assertPurchaseSignature, buildPurchaseAuthorization } from "./token-authorization";
import { purchaseMatches } from "./purchase-journal";
export type OfferPreview = { configuration: Configuration; asset: { symbol: string; decimals: number } };
const relayFailureMessages: Record<string, string> = {
  DAILY_BUDGET: "The relayer has reached its daily gas limit. Try again later or pay the network fee yourself.",
  RELAYER_BALANCE: "The relayer needs more MON for network fees. Try again later or pay the network fee yourself.",
  GAS_PRICE: "Network fees are above the relayer's limit. Try again later or pay the network fee yourself.",
  GAS_LIMIT: "This payment needs more gas than the relayer allows. You can pay the network fee yourself.",
  AUTHORIZATION_EXPIRED: "The payment authorization expired. Sign a new one to try again.",
  TRANSACTION_REVERTED: "The payment transaction failed on-chain. Check your token balance, then try again.",
};
function summary(product: Product, configuration: Configuration): Product {
  const terms = configuration.terms;
  return { ...product, draftTerms: { token: terms.token, price: terms.price, eventEnd: terms.hasEventEnd ? terms.eventEnd : null, reviewWindow: terms.reviewWindow, commitmentWindow: Number(terms.commitmentWindow) } };
}
function PurchaseResult({ record, productTitle, onBuyAgain }: { record: Operation; productTitle: string; onBuyAgain: () => void }) {
  const confettiRef = useRef<ConfettiRef>(null);
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setTimeout(() => {
      void confettiRef.current?.fire({ particleCount: 110, spread: 75, startVelocity: 35, origin: { x: .5, y: .42 },
        colors: ["#78e7a5", "#a6f5c0", "#f8d968", "#8bc8ff", "#ffffff"] });
    }, 160);
    return () => window.clearTimeout(timer);
  }, [record.id]);

  return <section className="card purchase-result">
    <Confetti ref={confettiRef} className="purchase-result-confetti" aria-hidden="true" />
    <div className="purchase-result-icon"><CheckCircle2 aria-hidden="true" /></div>
    <p className="purchase-result-eyebrow">Payment confirmed</p>
    <h2>Order placed</h2>
    <p className="purchase-result-product">{productTitle}</p>
    <span className="purchase-result-order">Order #{record.orderId}</span>
    <p className="purchase-result-message">Your payment is held in escrow. Open your order to follow delivery and see updates.</p>
    <div className="purchase-result-actions"><Button asChild><Link to={`/purchases/${record.orderId}`}><ArrowRight />Open order</Link></Button></div>
    <Button icon={ShoppingBag} variant="ghost" onClick={onBuyAgain}>Buy again</Button>
    {record.hashes.length > 0 && <details className="purchase-result-transactions"><summary>Transaction details</summary>{record.hashes.map(hash => <p className="address" key={hash}>{hash}</p>)}</details>}
  </section>;
}
export function ProductPage() {
  const { id } = useParams(), location = useLocation(), navigate = useNavigate(), api = useCommerce();
  const [checkout, setCheckout] = useState(false), [completed, setCompleted] = useState(false), [product, setProduct] = useState<Product>(), [preview, setPreview] = useState<OfferPreview>();
  const [error, setError] = useState(""), [previewError, setPreviewError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { let live = true; setProduct(undefined); setError(""); void api.read<Product>(`/products/${id}`).then(value => { if (live) setProduct(value); }).catch(cause => { if (live) setError(cause.message); }); return () => { live = false; }; }, [id]);
  useEffect(() => { let live = true; setPreview(undefined); setPreviewError(""); void api.read<OfferPreview>(`/products/${id}/preview`).then(value => { if (live) setPreview(value); }).catch(() => { if (live) setPreviewError("Offer details are temporarily unavailable. Try again to check the current price and availability."); }); return () => { live = false; }; }, [id, attempt]);
  useEffect(() => { setCheckout((location.state as { checkout?: boolean } | null)?.checkout === true); }, [id, location.key]);
  const available = preview?.configuration.status === 1 && preview.configuration.allowed;
  function showCheckout(value: boolean) {
    setCheckout(value); setCompleted(false);
    // Keep the current step when the wallet session changes and Routes remounts.
    navigate(location.pathname, { replace: true, state: value ? { checkout: true } : null });
  }
  return <section className="commerce-page buyer-offer">{checkout ? completed ? <Button asChild variant="ghost"><Link to="/purchases"><ArrowLeft aria-hidden="true" />Back to purchases</Link></Button> : <Button icon={ArrowLeft} variant="ghost" onClick={() => showCheckout(false)}>Back to offer</Button> : <Button asChild variant="ghost"><Link to="/discover"><ArrowLeft aria-hidden="true" />Back to Discover</Link></Button>}<h1>{checkout ? completed ? "Purchase complete" : "Your purchase" : "Offer details"}</h1>
    {error ? <p role="alert">This offer could not be loaded: {error}</p> : !product ? <p role="status">Loading offer...</p> : checkout ? <BuyerCheckout key={id} product={product} preview={preview} resumeId={(location.state as { resumeId?: string } | null)?.resumeId} onCompletionChange={setCompleted} /> : <>
      <section className="card offer-review">{preview ? <><OfferReview product={summary(product, preview.configuration)} publicPreview assetDetails={preview.asset} seller={preview.configuration.seller} />{!available && <p className="offer-availability" role="status">{preview.configuration.status !== 1 ? "Sales paused" : "This payment token is currently unavailable"}</p>}</> : <><OfferGallery images={product.images ?? []} title={product.title} /><h2>{product.title}</h2><p>{product.description}</p><p role={previewError ? "alert" : "status"}>{previewError || "Checking price and availability..."}</p>{previewError && <Button icon={RefreshCw} onClick={() => setAttempt(value => value + 1)}>Retry</Button>}</>}
      <div className="offer-buy-actions"><Button icon={ShoppingBag} className="rainbow-button" disabled={!available} onClick={() => showCheckout(true)}>Buy</Button></div>
      </section>
    </>}
  </section>;
}
export function BuyerCheckout({ product, preview, resumeId, onCompletionChange }: { product: Product; preview?: OfferPreview; resumeId?: string; onCompletionChange?: (completed: boolean) => void }) {
  const api = useCommerce(), access = useCommerceAccess(), wallet = useSession(), task = useTask(), location = useLocation(), navigate = useNavigate();
  const [record, setRecord] = useState<Operation>(), [loaded, setLoaded] = useState(false), [asset, setAsset] = useState<Asset>();
  const [notice, setNotice] = useState(""), [topUp, setTopUp] = useState<{ symbol: string; token: string }>();
  const [balanceError, setBalanceError] = useState("");
  const [transactionBusy, setTransactionBusy] = useState(false), [restoreAttempt, setRestoreAttempt] = useState(0);
  const [transactionReviewOpen, setTransactionReviewOpen] = useState(false);
  const [paySelf, setPaySelf] = useState(false);
  const config = record?.configuration ?? preview?.configuration;
  const canCoverFees = config?.authorizationMode === "eip3009-receive" && config.terms.token !== native;
  const sponsored = canCoverFees && !paySelf && !record?.action;
  const done = record?.progress === "finalized";
  useEffect(() => { onCompletionChange?.(done); }, [done, onCompletionChange]);
  const pending = record?.progress === "checking";
  const payment = !!record && (pending || (!sponsored && (record.progress === "review" || record.progress === "reverted" || (record.action?.kind === "approve" && record.progress === "draft"))));
  useEffect(() => { if (!access.authenticated || !wallet.session) return; let live = true; setLoaded(false); task.setError(""); void journal.list(wallet.session.address).then(async rows => {
    const deployment = await api.read<{ chainId: number; contract: string }>("/deployment");
    const matching = rows.filter(row => row.productId === product.id && row.requestId && row.deployment.chainId === deployment.chainId && row.deployment.contract.toLowerCase() === deployment.contract.toLowerCase());
    const latest = resumeId ? matching.find(row => row.id === resumeId) : matching.at(-1);
    if (resumeId && !latest) throw new Error("This saved checkout is no longer available. Go back to the offer to start a new purchase.");
    // A completed order is history, not the next checkout for this offer.
    const saved = latest?.progress === "finalized" && !resumeId ? undefined : latest;
    if (live) { setRecord(saved); setPaySelf(current => saved ? saved.payNetworkFeeSelf ?? !!saved.action : current); setLoaded(true); }
  }).catch(cause => { if (live) task.setError(cause.message); }); return () => { live = false; }; }, [product.id, resumeId, wallet.sessionEpoch, access.authenticated, restoreAttempt]);
  useEffect(() => { let live = true; setAsset(undefined); setBalanceError(""); if (access.address && config && !done) void api.read<Asset>(`/public/wallets/${access.address}/assets/${config.terms.token}`).then(value => { if (live) setAsset(value); }).catch(() => { if (live) setBalanceError("Could not load balances. Refresh to try again."); }); return () => { live = false; }; }, [access.address, config?.terms.token, record?.progress, done]);
  async function loadAsset(configuration: Configuration) { if (!access.address) throw new Error("Choose a wallet to check its balance."); const value = await api.read<Asset>(`/public/wallets/${access.address}/assets/${configuration.terms.token}`); setAsset(value); setBalanceError(""); return value; }
  async function checkSponsored() {
    if (!record?.requestId || record.progress !== "checking" || !sponsored || !access.authenticated) return;
    const recovered = await api.request<{ status: string; orderId?: string; order?: { buyer: string; requestId: string; buyerReceiving: { nonce: string; publicKey: string } } }>(`/orders/recover/${record.requestId}`);
    if (recovered.status === "finalized") {
      if (!recovered.order || !purchaseMatches(record, recovered.order)) throw new Error("The purchase reference belongs to another receiving key. Open Purchases to inspect it.");
      setRecord(await journal.save({ ...record, progress: "finalized", orderId: recovered.orderId }));
      return;
    }
    if (!record.relayJobId) return;
    const job = await api.read<{ status: string; transactionHash: string | null; failureReason: string | null }>(`/relay/jobs/${record.relayJobId}`);
    if (job.status === "failed") { setRecord(await journal.save({ ...record, progress: "reverted", relayFailureReason: job.failureReason ?? undefined })); return; }
    if (job.transactionHash && job.transactionHash !== record.activeHash) setRecord(await journal.save({ ...record, activeHash: job.transactionHash, hashes: [...record.hashes, job.transactionHash] }));
  }
  useEffect(() => {
    if (!sponsored || record?.progress !== "checking" || !access.authenticated) return;
    const timer = window.setInterval(() => { if (!task.busy) void task.run(checkSponsored); }, 4000);
    return () => window.clearInterval(timer);
  }, [sponsored, record?.progress, record?.relayJobId, record?.activeHash, task.busy, access.authenticated]);
  async function refreshTerms() {
    if (!record || pending || done || payment) return;
    const response = await api.request<{ configuration: Configuration }>(`/products/${product.id}/checkout/refresh`, { requestId: record.requestId });
    const changed = record.configuration?.expectedTerms !== response.configuration.expectedTerms;
    setRecord(await journal.save({ ...record, configuration: response.configuration, transaction: undefined, action: undefined, activeHash: undefined, progress: "draft" }));
    setNotice(changed ? "The offer terms changed. Review the updated details before continuing." : "Terms refreshed. Review them before continuing."); await loadAsset(response.configuration);
  }
  async function prepare(next: Operation, configuration: Configuration, balances: Asset) {
    if (next.progress === "checking" || next.progress === "finalized") throw new Error("Check the current payment status before continuing.");
    if (!configuration.allowed || configuration.status !== 1) throw new Error("This offer is not currently available.");
    if (BigInt(balances.balance) < BigInt(configuration.terms.price)) throw new Error("Top up your payment balance to continue.");
    const approval = configuration.terms.token !== native && BigInt(balances.allowance) < BigInt(configuration.terms.price);
    setRecord(await prepareOperation(api, next, { kind: approval ? "approve" : "purchase", requestId: next.requestId!, expectedTerms: configuration.expectedTerms }, paySelf));
    setTransactionReviewOpen(true);
  }
  async function submitSponsored() {
    if (!record?.requestId || !record.receiving || !record.configuration || !wallet.session || !access.authenticated) throw new Error("Finish sign-in and receiving-key setup first.");
    if (record.progress === "finalized" || (record.progress === "checking" && record.relayJobId)) throw new Error("Check the current payment before signing again.");
    const balances = await loadAsset(record.configuration);
    if (BigInt(balances.balance) < BigInt(record.configuration.terms.price)) throw new Error("Top up your payment balance to continue.");
    const deployment = await api.read<Deployment>("/deployment");
    const packet = buildPurchaseAuthorization({ configuration: record.configuration, deployment, asset: balances, buyer: wallet.session.address,
      requestId: record.requestId, receiving: record.receiving, title: product.title });
    const signature = await wallet.runOperation(async (session, isCurrent) => {
      if (!isCurrent() || session.address.toLowerCase() !== record.account || !session.signTypedData) throw new Error("This wallet cannot sign token authorizations. Choose the user-paid route.");
      const signed = await session.signTypedData(packet.typedData);
      if (!isCurrent()) throw new Error("Wallet changed. Check purchase status before retrying.");
      assertPurchaseSignature(packet.typedData, signed, record.account);
      return signed;
    });
    const checking = await journal.save({ ...record, action: undefined, transaction: undefined, relayNonce: packet.nonce, relayJobId: undefined, relayFailureReason: undefined,
      activeHash: undefined, progress: "checking" });
    setRecord(checking);
    const job = await api.request<{ id: string }>("/relay/payments", { kind: "purchase", chainId: deployment.chainId, escrow: deployment.contract, router: deployment.router,
      intent: packet.intent, authorization: { ...packet.authorization, signature } });
    setRecord(await journal.save({ ...checking, relayJobId: job.id }));
  }
  async function continueCheckout() {
    if (!config || !access.authenticated || !wallet.session || pending || done) return;
    if (config.seller.toLowerCase() === wallet.session.address.toLowerCase()) throw new Error("You can't buy your own offer.");
    const currentBalance = await loadAsset(config);
    if (BigInt(currentBalance.balance) < BigInt(config.terms.price)) throw new Error("Top up your payment balance to continue.");
    let next = record;
    if (!next) {
      const deployment = await api.read<{ chainId: 10143; contract: string }>("/deployment");
      const context = newReceivingContext({ chainId: deployment.chainId, contract: deployment.contract }, wallet.session!.address), requestId = randomId();
      next = await journal.save({ id: requestId, account: wallet.session!.address.toLowerCase(), deployment: context.deployment, requestId, context, productId: product.id, hashes: [], progress: "draft", version: 0, payNetworkFeeSelf: paySelf }); setRecord(next);
    }
    if (!next.configuration) {
      if (!next.receiving) {
        const identity = await wallet.runOperation((session, isCurrent) => restoreReceiving(next!.context!, session, isCurrent));
        try { next = await journal.save({ ...next, receiving: { nonce: identity.context.nonce, publicKey: hexlify(decodeBase64(identity.publicKey, 32)) } }); setRecord(next); } finally { identity.privateKey.fill(0); }
      }
      const response = await api.request<{ configuration: Configuration }>(`/products/${product.id}/checkout`, { requestId: next.requestId, buyerReceiving: next.receiving });
      next = await journal.save({ ...next, configuration: response.configuration }); setRecord(next);
      if (response.configuration.expectedTerms !== config.expectedTerms) { setNotice("The offer terms changed. Review the updated details before continuing."); await loadAsset(response.configuration); return; }
    }
    if (next.configuration?.authorizationMode === "eip3009-receive" && !paySelf) return;
    await prepare(next, next.configuration!, currentBalance);
  }
  async function backToPayment() {
    if (!record || pending || done) return;
    setRecord(await journal.save({ ...record, transaction: undefined, action: undefined, activeHash: undefined, progress: "draft" }));
  }
  async function changeFeeMode(selfPay: boolean) {
    if (!canCoverFees || pending || done || transactionBusy) return;
    if (record?.requestId) {
      const recovered = await api.request<{ status: string; orderId?: string; order?: { buyer: string; requestId: string; buyerReceiving: { nonce: string; publicKey: string } } }>(`/orders/recover/${record.requestId}`);
      if (recovered.status === "finalized") {
        if (!recovered.order || !purchaseMatches(record, recovered.order)) throw new Error("The purchase reference belongs to another receiving key.");
        setRecord(await journal.save({ ...record, progress: "finalized", orderId: recovered.orderId })); return;
      }
      setRecord(await journal.save({ ...record, progress: "draft", payNetworkFeeSelf: selfPay, action: undefined, transaction: undefined, activeHash: undefined, relayJobId: undefined, relayNonce: undefined, relayExpiresAt: undefined, relayFailureReason: undefined }));
    }
    setTransactionReviewOpen(false);
    setPaySelf(selfPay);
  }
  const enough = asset && config && BigInt(asset.balance) >= BigInt(config.terms.price);
  const step = done ? 2 : 1;
  const needsApproval = !!config && !sponsored && config.terms.token !== native && (!asset || BigInt(asset.allowance) < BigInt(config.terms.price));
  const sponsoredReady = sponsored && !!record?.receiving && !!record.configuration;
  const selfOffer = access.authenticated && !!wallet.session && config?.seller.toLowerCase() === wallet.session.address.toLowerCase();
  const lowBalance = access.authenticated && !!asset && !enough;
  const paymentAction = !access.authenticated ? wallet.session && !wallet.session.locked ? "Verify wallet to continue" : "Sign in to continue" : sponsored ? sponsoredReady ? record?.progress === "reverted" ? "Try authorization again" : "Authorize token payment" : "Sign receiving key" : record?.receiving ? needsApproval ? "Review token approval" : "Review payment" : "Sign receiving key and review";
  const feeSwitch = canCoverFees && <label className="buyer-fee-switch"><input type="checkbox" role="switch" checked={!sponsored} disabled={task.busy || access.busy || transactionBusy || pending || done} onChange={event => { const selfPay = event.currentTarget.checked; void task.run(() => changeFeeMode(selfPay)); }} /><span>Pay network fee myself</span></label>;
  return <><ol className="offer-flow-steps buyer-steps" aria-label="Purchase steps">{["Offer", "Payment", "Result"].map((label, index) => <li key={label} aria-current={step === index ? "step" : undefined}><span>{index < step ? <Check size={16} aria-label="Completed" /> : index + 1}</span>{label}</li>)}</ol>
    {access.authenticated && !loaded ? <><p role="status">Restoring checkout...</p>{task.error && <Button icon={RefreshCw} onClick={() => setRestoreAttempt(value => value + 1)}>Retry checkout</Button>}</> : done ? <PurchaseResult record={record} productTitle={product.title} onBuyAgain={() => { setRecord(undefined); setNotice(""); navigate(location.pathname, { replace: true, state: { checkout: true } }); }} /> : !config ? <p role="status">Checking current offer terms...</p> : <section className="card buyer-checkout">
      <h2>{pending ? record.action?.kind === "approve" ? "Checking token approval" : "Checking payment" : "Payment"}</h2>
      <OfferReview product={summary(product, config)} compact publicPreview assetDetails={asset ?? (preview?.configuration.terms.token === config.terms.token ? preview.asset : undefined)} />
      {!pending && <PaymentBalance address={access.address} asset={asset} configuration={config} selfPay={!sponsored} open={!payment} busy={task.busy} error={balanceError} onRefresh={() => void task.run(() => loadAsset(config))} onTopUp={setTopUp} />}
      {notice && <p role="status">{notice}</p>}
      <ol className="payment-signing-steps" aria-label="Payment steps"><li><span>1</span>Wallet access{access.authenticated && <Check size={16} aria-label="Completed" />}</li><li><span>2</span>Sign receiving key{record?.receiving && <Check size={16} aria-label="Completed" />}</li>{sponsored ? <li><span>3</span>Authorize exact token payment{pending && <Check size={16} aria-label="Completed" />}</li> : <>{config.terms.token !== native && <li><span>3</span>Approve token{!needsApproval && <Check size={16} aria-label="Completed" />}</li>}<li><span>{config.terms.token === native ? 3 : 4}</span>Confirm payment</li></>}</ol>
      {sponsored && record?.progress === "reverted" && <div className="buyer-payment-warning" role="alert"><p>{relayFailureMessages[record.relayFailureReason ?? ""] ?? "The relayer could not submit this payment. Try again or pay the network fee yourself."} No payment was made.</p></div>}
      {!pending && <p className="buyer-fee-status" role="status">{sponsored ? "Network fee covered." : "You pay network fees in MON."}</p>}
      {!payment ? <>{!sponsored && <p className="muted">External wallets ask you to confirm sign-in and receiving-key messages separately.</p>}{(selfOffer || lowBalance) && <div className="buyer-payment-warning" role="alert">{selfOffer && <p>You cannot buy your own offer.</p>}{lowBalance && <p>Your {asset?.symbol} balance is too low for this purchase. Top up before continuing.</p>}</div>}<div className="offer-review-actions">{record?.configuration && <Button icon={RefreshCw} variant="secondary" disabled={task.busy} onClick={() => void task.run(refreshTerms)}>Refresh terms</Button>}<div className="buyer-payment-actions">{feeSwitch}<Button icon={ArrowRight} disabled={task.busy || access.busy || !config.allowed || config.status !== 1 || (selfOffer || lowBalance)} onClick={() => access.authenticated ? void task.run(sponsoredReady ? submitSponsored : continueCheckout) : access.authorize()}>{paymentAction}</Button></div></div>{access.error && <p role="alert">{access.error}</p>}</> : sponsored ? <><p role="status">{record.relayJobId ? "Waiting for the relayer and finalized payment." : "Payment submission is uncertain. Check the order before authorizing again."}</p><div className="actions">{feeSwitch}<Button icon={RefreshCw} variant="secondary" disabled={task.busy} onClick={() => void task.run(checkSponsored)}>Check payment status</Button>{!record.relayJobId && <Button disabled={task.busy} onClick={() => void task.run(submitSponsored)}>Retry authorization</Button>}</div>{record.activeHash && <p className="address">Transaction: {record.activeHash}</p>}</> : <>
        <p>{record.action?.kind === "approve" ? record.progress === "draft" ? "Token approval confirmed. Continue to review your payment." : "First, allow payment of exactly this price. Approval alone does not place an order." : pending ? "Your payment is being checked. You can return later; this purchase will resume here." : "Confirm your payment to place the order. Network fees are paid in MON."}</p>
        <div className="buyer-payment-actions">{feeSwitch}{record.progress !== "draft" && <Button icon={ArrowRight} onClick={() => setTransactionReviewOpen(true)}>{pending ? "Check transaction status" : record.action?.kind === "approve" ? "Review token approval" : "Review payment"}</Button>}
        {record.progress === "draft" && <Button icon={ArrowRight} disabled={task.busy || !asset} onClick={() => void task.run(async () => prepare(record, config, await loadAsset(config)))}>Continue to payment</Button>}</div>
        {!pending && <Button icon={ArrowLeft} variant="secondary" disabled={task.busy || transactionBusy} onClick={() => void task.run(backToPayment)}>Back to payment</Button>}
      </>}
    </section>}
    {transactionReviewOpen && payment && !sponsored && record && record.progress !== "draft" && <OrderDialog title={record.action?.kind === "approve" ? "Token approval" : "Payment"} onClose={() => { if (!transactionBusy) setTransactionReviewOpen(false); }}><TransactionPanel key={record.id} record={record} onChange={next => { setRecord(next); if (next.progress === "draft" || next.progress === "finalized") setTransactionReviewOpen(false); }} buyerView compactReview onBusyChange={setTransactionBusy} onRetry={async () => { await backToPayment(); setTransactionReviewOpen(false); }} retryLabel="Back to payment" /><Feedback {...task} /></OrderDialog>}
    <Feedback {...task} />
    {topUp && config && access.address && <TopUpDialog symbol={topUp.symbol} address={access.address} chainId={config.chainId} providers={tokenPresentation(config.chainId, topUp.token).topUpProviders ?? []} onClose={() => setTopUp(undefined)} />}
  </>;
}
