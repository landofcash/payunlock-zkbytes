import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowRight, RefreshCw } from "lucide-react";
import { decodeBase64 } from "@zkbytes/sdk";
import { formatUnits, hexlify } from "ethers";
import { Button } from "@/components/ui/button";
import { TopUpDialog } from "@/wallet/TopUpDialog";
import { useSession } from "@/wallet/session-store";
import { tokenPresentation } from "@/config/token-icons";
import { useCommerce, useCommerceAccess, type Asset, type Configuration, type Product } from "./client";
import { OfferReview } from "./OfferReview";
import { PaymentBalance } from "./PaymentBalance";
import { newReceivingContext, restoreReceiving } from "./protocol";
import type { Operation } from "./purchase-journal";
import { checkBuiltinPurchase, executeBuiltinPurchase, prepareBuiltinPurchase, retryBuiltinPurchase, type PurchasePlan } from "./builtin-purchase";
import { Feedback, journal, randomId, useTask } from "./ui";

export function BuiltinBuyerCheckout({ product, preview, resumeId, onCompletionChange, result }: {
  product: Product; preview?: { configuration: Configuration; asset: { symbol: string; decimals: number } }; resumeId?: string;
  onCompletionChange?: (done: boolean) => void; result(record: Operation, again: () => void): ReactNode;
}) {
  const api = useCommerce(), access = useCommerceAccess(), wallet = useSession(), task = useTask();
  const location = useLocation(), navigate = useNavigate();
  const [record, setRecord] = useState<Operation>(), [loaded, setLoaded] = useState(false), [plan, setPlan] = useState<PurchasePlan>();
  const [asset, setAsset] = useState<Asset>(), [paySelf, setPaySelf] = useState(false), [attempt, setAttempt] = useState(0);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const [notice, setNotice] = useState(""), [topUp, setTopUp] = useState<{ symbol: string; token: string }>();
  const latest = useRef(record), mounted = useRef(false);
  const config = record?.configuration ?? preview?.configuration;
  const pending = record?.progress === "checking", done = record?.progress === "finalized";
  const canRetryPayment = pending && !!record.relayNonce && !record.relayJobId && !record.activeHash && !record.action;
  const covered = config?.authorizationMode === "eip3009-receive" && !paySelf;
  const selfOffer = config?.seller.toLowerCase() === wallet.session?.address.toLowerCase();
  function update(next: Operation) { latest.current = next; if (mounted.current) setRecord(next); }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { onCompletionChange?.(done); }, [done, onCompletionChange]);
  useEffect(() => {
    let live = true; setLoaded(false); setPlan(undefined);
    if (!access.authenticated || !wallet.session) return;
    void (async () => {
      const deployment = await api.read<{ chainId: number; contract: string }>("/deployment");
      const rows = (await journal.list(wallet.session!.address)).filter(row => row.productId === product.id && row.requestId && row.deployment.chainId === deployment.chainId && row.deployment.contract.toLowerCase() === deployment.contract.toLowerCase());
      const saved = resumeId ? rows.find(row => row.id === resumeId) : rows.at(-1);
      if (resumeId && !saved) throw new Error("This saved checkout is unavailable. Return to the offer to start again.");
      if (!live) return;
      const next = saved?.progress === "finalized" && !resumeId ? undefined : saved;
      latest.current = next; setRecord(next); setPaySelf(next?.payNetworkFeeSelf ?? !!next?.action); setLoaded(true);
    })().catch(error => { if (live) task.setError(error.message); });
    return () => { live = false; };
  }, [product.id, resumeId, access.authenticated, wallet.sessionEpoch, restoreAttempt]);
  async function balances(configuration: Configuration) {
    const value = await api.read<Asset>(`/public/wallets/${wallet.session!.address}/assets/${configuration.terms.token}`);
    if (mounted.current) setAsset(value);
    return value;
  }
  // Preparation contains no spending. Only the button below grants permission.
  useEffect(() => {
    if (!loaded || !access.authenticated || !config || latest.current?.progress === "checking" || latest.current?.progress === "finalized") return;
    let live = true; setPlan(undefined);
    void task.run(async () => {
      let next = latest.current;
      const initial = next?.configuration ?? preview!.configuration;
      if (selfOffer) throw new Error("You cannot buy your own offer.");
      // Saved terms must be refreshed before checking their payment token or price.
      if (!next?.configuration) {
        const funds = await balances(initial);
        if (BigInt(funds.balance) < BigInt(initial.terms.price)) throw new Error("Top up your payment balance to continue.");
      }
      if (!live) return;
      if (!next) {
        const deployment = await api.read<{ chainId: 10143; contract: string }>("/deployment");
        if (!live) return;
        const context = newReceivingContext({ chainId: deployment.chainId, contract: deployment.contract }, wallet.session!.address), requestId = randomId();
        next = await journal.save({ id: requestId, requestId, account: wallet.session!.address.toLowerCase(), productId: product.id, deployment: context.deployment, context, hashes: [], progress: "draft", version: 0 }); update(next);
      }
      if (!next.receiving) {
        const identity = await wallet.runOperation((session, current) => restoreReceiving(next!.context!, session, () => live && current()));
        try { next = await journal.save({ ...next, receiving: { nonce: identity.context.nonce, publicKey: hexlify(decodeBase64(identity.publicKey, 32)) } }); update(next); }
        finally { identity.privateKey.fill(0); }
      }
      if (!live) return;
      const response = await api.request<{ configuration: Configuration }>(`/products/${product.id}/checkout${next.configuration ? "/refresh" : ""}`, next.configuration ? { requestId: next.requestId } : { requestId: next.requestId, buyerReceiving: next.receiving });
      next = await journal.save({ ...next, configuration: response.configuration, payNetworkFeeSelf: paySelf, progress: "draft", action: undefined, transaction: undefined, activeHash: undefined, relayNonce: undefined, relayJobId: undefined }); update(next);
      if (!live) return;
      if (response.configuration.expectedTerms !== initial.expectedTerms) setNotice("The offer terms changed. Review the updated details before paying.");
      const ready = await prepareBuiltinPurchase(api, next, await balances(response.configuration), product.title);
      if (live) setPlan(ready);
    });
    return () => { live = false; };
  }, [loaded, access.authenticated, wallet.sessionEpoch, paySelf, attempt, !!config]);
  async function check() {
    const before = latest.current;
    if (!before || before.progress !== "checking") return;
    const next = await checkBuiltinPurchase(api, journal, before); update(next);
    if (next.progress === "reverted") setNotice("The previous payment attempt failed. Review the purchase before trying again.");
    if (next.progress === "draft" || next.progress === "reverted") setAttempt(value => value + 1);
  }
  useEffect(() => {
    if (!pending || !access.authenticated || task.busy) return;
    const timer = setInterval(() => { void task.run(check); }, 4000);
    return () => clearInterval(timer);
  }, [pending, access.authenticated, task.busy, record?.version]);
  async function confirm(retryPayment = false) {
    if (!retryPayment && !plan) return;
    let approved = plan; setPlan(undefined); setNotice("");
    try {
      if (retryPayment) {
        const next = await retryBuiltinPurchase(api, journal, latest.current!);
        if (next.progress === "finalized") { update(next); return; }
        if (!mounted.current) return;
        approved = await prepareBuiltinPurchase(api, next, await balances(next.configuration!), product.title);
      }
      if (!mounted.current) return;
      await wallet.runOperation((session, current) => executeBuiltinPurchase({ api, journal, plan: approved!, session, current: () => mounted.current && current(), onChange: update }));
    } catch (error) {
      if (mounted.current) setNotice(error instanceof Error ? error.message : "Payment interrupted. Review the purchase before continuing.");
      throw error;
    } finally {
      if (mounted.current && latest.current?.progress !== "checking") setAttempt(value => value + 1);
    }
  }
  function retry() { setPlan(undefined); if (!loaded) setRestoreAttempt(value => value + 1); else setAttempt(value => value + 1); }
  return <>
    <ol className="offer-flow-steps buyer-steps" aria-label="Purchase steps">{["Offer", "Payment", "Result"].map((label, index) => <li key={label} aria-current={(done ? 2 : 1) === index ? "step" : undefined}><span>{index + 1}</span>{label}</li>)}</ol>
    {done && record ? result(record, () => { latest.current = undefined; setRecord(undefined); setNotice(""); navigate(location.pathname, { replace: true, state: { checkout: true } }); retry(); }) : !config ? <p role="status">Checking current offer terms...</p> : <section className="card buyer-checkout">
      <h2>{pending ? record?.action?.kind === "approve" ? "Preparing payment" : "Checking payment" : "Review purchase"}</h2>
      <OfferReview product={{ ...product, draftTerms: { token: config.terms.token, price: config.terms.price, eventEnd: config.terms.hasEventEnd ? config.terms.eventEnd : null, reviewWindow: config.terms.reviewWindow, commitmentWindow: Number(config.terms.commitmentWindow) } }} compact publicPreview seller={config.seller} assetDetails={asset ?? preview?.asset} />
      {!pending && <PaymentBalance address={access.address} asset={asset} configuration={config} selfPay={!covered} feeChoice={config.authorizationMode === "eip3009-receive" ? { disabled: task.busy, onChange: value => { setPlan(undefined); setPaySelf(value); } } : undefined} busy={task.busy} error="" onRefresh={retry} onTopUp={setTopUp} />}
      {notice && <p role="status">{notice}</p>}
      {access.authenticated ? <>
        {!pending && <p className="buyer-fee-status">{covered ? "Network fee covered." : plan ? `Maximum total network fee: ${formatUnits(plan.maxNetworkFee, 18)} MON` : "Checking network fees..."}</p>}
        {plan?.approval && <p>Token approval and payment will run automatically after you confirm. The maximum fee covers both transactions.</p>}
        {pending ? <><p role="status">{task.busy ? record?.action?.kind === "approve" ? "Approving token payment. Your order will be placed automatically after confirmation." : "Submitting your payment..." : canRetryPayment ? "Payment submission was not confirmed. Check its status or retry this purchase." : "Checking the payment. You can return later; progress is saved."}</p><Button icon={RefreshCw} disabled={task.busy} onClick={() => void task.run(check)}>Check payment status</Button>{canRetryPayment && <Button icon={RefreshCw} disabled={task.busy} onClick={() => void task.run(() => confirm(true))}>Retry payment</Button>}</> : <div className="buyer-payment-actions">
          {!plan && !task.busy && <Button icon={RefreshCw} variant="secondary" onClick={retry}>Refresh purchase</Button>}
          <Button icon={ArrowRight} loading={task.busy} disabled={!plan || task.busy || selfOffer} onClick={() => void task.run(confirm)}>Pay {formatUnits(config.terms.price, asset?.decimals ?? preview?.asset.decimals ?? 18)} {asset?.symbol ?? preview?.asset.symbol} and place order</Button>
        </div>}
      </> : <Button icon={ArrowRight} disabled={access.busy} onClick={() => access.authorize()}>Sign in to continue</Button>}
      {access.error && <p role="alert">{access.error}</p>}
    </section>}
    <Feedback {...task} />
    {topUp && config && access.address && <TopUpDialog symbol={topUp.symbol} address={access.address} chainId={config.chainId} providers={tokenPresentation(config.chainId, topUp.token).topUpProviders ?? []} onClose={() => setTopUp(undefined)} />}
  </>;
}
