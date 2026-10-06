import { LoaderCircle, CircleAlert } from "lucide-react";
import { LockKeyhole as ButtonLockKeyhole, Send as ButtonSend, RefreshCw as ButtonRefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { formatUnits, keccak256, Transaction, verifyTypedData, ZeroAddress } from "ethers";
import { IndexedStore } from "@/storage/local-store";
import { useSession } from "@/wallet/session-store";
import { walletErrorKind } from "@/wallet/errors";
import type { ReviewedTransaction } from "@/wallet/managed-session";
import { sellerClaimAbi } from "@/wallet/seller-authorization";
import { ApiError, useCommerce, useCommerceAccess, type Action, type Deployment, type PreparedTx, type Terms } from "./client";
import type { ReviewedTypedData } from "@/wallet/types";
import { PurchaseJournal, purchaseMatches, type Operation } from "./purchase-journal";
import type { Receiving } from "./client";
import { reconcileAction } from "./reconcile";
import { TransactionReview } from "./TransactionReview";
import { TransactionDialogContext } from "./transaction-dialog-context";
export const journal = new PurchaseJournal(new IndexedStore());
export const native = ZeroAddress;
export const randomId = () => `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("")}`;
export const date = (seconds: string) => seconds === "0" ? "Not started" : new Date(Number(seconds) * 1000).toLocaleString();
const relayedActions = new Set(["update", "disable", "cancelProduct", "reserveDelivery", "reserveDeliveries", "publishDelivery", "publishDeliveries",
  "claimRefund", "refundCanceledOrders", "claimFees", "confirmReceipt", "withdrawSeller", "openDispute", "replyToDispute", "refundDisputedOrder",
  "claimResponseTimeout", "submitArbitrationEvidence", "requestArbitrationEvidence", "resolveArbitration", "setMyArbitrationFee", "setSellerFeeCap"]);
const canRelay = (action: Action | undefined) => !!action && relayedActions.has(action.kind);
export function actionDescription(action: Action | undefined) {
  if (!action) return "Transaction";
  switch (action.kind) {
    case "reserveDelivery": return "Commit delivery (step 1 of 2). Approve publication immediately after finality.";
    case "publishDelivery": return "Publish encrypted delivery (step 2 of 2). Starts the buyer review period.";
    case "confirmReceipt": return "Accept delivery and allow the seller to claim payment.";
    case "refundDisputedOrder": return "Send a full refund to the buyer.";
    case "resolveArbitration": return `Final award: full ${action.sellerWins ? "seller payout" : "buyer refund"}, assignment ${action.revision}.`;
    case "requestArbitration": return `Activate arbitration with ${action.wallet}, key ${action.expectedKeyVersion}. Non-refundable fee: ${action.expectedFee} base units of ${action.expectedFeeAsset}.`;
    case "approveArbitrationFee": return `Allow PayUnlock to collect exactly ${action.expectedFee} base units of ${action.expectedFeeAsset} for arbitration with ${action.arbitrator}. Return to your evidence draft after this transaction finalizes.`;
    case "replaceArbitrator": return `Replace assignment ${action.revision} with ${action.replacement}, key ${action.expectedKeyVersion}. Reason hash: ${action.reason}.`;
    case "setResponseWindow": return `Set future negotiation response duration to ${action.value} seconds.`;
    case "setAllowedAsset": return `${action.allowed ? "Enable" : "Disable"} payment asset ${action.asset === native ? "MON" : action.asset}. Disabling blocks new purchases and offer creation/updates with this asset. Existing orders can still be delivered, refunded, and paid out.`;
    case "setBatchLimit": return `Set batch limit to ${action.value}. Pending batches may need splitting; order deadlines stay unchanged.`;
    case "setTimingBounds": return `Set future response minimum to ${action.responseFloor}s and publication bounds to ${action.commitmentFloor} to ${action.commitmentCeiling}s. Existing orders keep their terms.`;
    case "addStorageService": return `Permanently register storage service ID ${action.serviceId}. This cannot be undone or reassigned; an application adapter is also required.`;
    case "setDefaultReviewWindow": return `Set future default review duration to ${action.value} seconds.`;
    case "configureArbitrator": return `${action.active ? "Enable" : "Disable"} arbitrator ${action.wallet}; public key ${action.publicKey}. The arbitrator sets their own fee on V5.`;
    case "setMyArbitrationFee": return `Set your arbitration fee to ${action.fee} token base units at fee version ${action.expectedVersion}.`;
    case "setServiceFee": return `Set seller payout service fee to ${action.bps} basis points, sent to ${action.treasury}. Existing orders retain their snapshot.`;
    case "setOfferPlacementFee": return `Set the MON fee for new offer placement to ${action.amount} wei.`;
    case "setArbitrationFeeAsset": return `Set the arbitration fee token to ${action.asset}. Future cases must review a new quote.`;
    case "setReceiveAuthorizationAsset": return `${action.enabled ? "Enable" : "Disable"} EIP-3009 receive authorization for ${action.asset}. Enable only after verifying that token's behavior and signing domain.`;
    case "claimFees": return `Claim your accrued platform fees in ${action.asset === native ? "MON" : action.asset}.`;
    case "requestArbitrationEvidence": return `Request evidence from ${action.participant}, encrypted request #${action.expectedIndex}; advisory date ${date(action.advisoryDate)}.`;
    default: return action.kind.replace(/([A-Z])/g, " $1");
  }
}
export function TermsView({ terms }: { terms: Terms }) {
  return <><dl className="terms"><dt>Payment</dt><dd>{terms.token === native ? formatUnits(terms.price, 18) : terms.price} {terms.token === native ? "MON" : "base units"} · {terms.token === native ? "MON (18 decimals)" : terms.token}</dd><dt>Event end</dt><dd>{terms.hasEventEnd ? date(terms.eventEnd) : "No event end"}</dd><dt>Review time</dt><dd>{terms.reviewWindow} seconds after delivery or event end, whichever is later</dd><dt>Delivery publication window</dt><dd>{terms.commitmentWindow} seconds after the seller commits delivery</dd><dt>Negotiation response time</dt><dd>{terms.responseWindow} seconds per turn</dd></dl><p>Accepting delivery early ends your review and allows seller payout. Before a delivery commitment you can claim a refund. During publication the refund is temporarily locked; if publication expires, you can claim it again.</p><p>Either participant may request arbitration during an active negotiation. Review the arbitrator's current key and token-denominated fee before activation. The initiator pays that fee directly to the arbitrator. During arbitration only the arbitrator decides. Evidence is stored for one year from preparation.</p></>;
}
export function WalletGate({ expectedAddress }: { expectedAddress?: string }) { const access = useCommerceAccess(); return <p><Button icon={ButtonLockKeyhole} onClick={() => access.unlock(expectedAddress)}>Sign in to continue</Button></p>; }
export function useTask() {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const running = useRef(false);
  async function run(task: () => Promise<unknown>) { if (running.current) return; running.current = true; setBusy(true); setError(""); try { await task(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not complete this action."); } finally { running.current = false; setBusy(false); } }
  return { busy, error, run, setError };
}
export function Feedback({ busy, error }: { busy: boolean; error: string }) { return <>{busy && <p className="status-message" role="status"><LoaderCircle size={16} className="spin" aria-hidden="true" />Working...</p>}{error && <p className="status-message" role="alert"><CircleAlert size={16} aria-hidden="true" />{error}</p>}</>; }
export function TransactionPanel({ record, onChange, onFinalized, autoSubmit = false, buyerView = false, compactReview = false, onBusyChange, summary, subject, confirmLabel, onRetry, retryLabel, singleApproval = false, onApprove, beforeSubmit, onSubmissionError, maximumFee }: { record: Operation; onChange(record: Operation): void; onFinalized?(): Promise<void>; autoSubmit?: boolean; buyerView?: boolean; compactReview?: boolean; onBusyChange?(busy: boolean): void; summary?: ReactNode; subject?: string; confirmLabel?: string; onRetry?(): Promise<unknown>; retryLabel?: string; singleApproval?: boolean; onApprove?(selfPay: boolean, router?: string): void; beforeSubmit?(): Promise<void>; onSubmissionError?(): void; maximumFee?: bigint }) {
  const api = useCommerce(), wallet = useSession(), task = useTask(), location = useLocation();
  const [router, setRouter] = useState<string>();
  const [coverageLoaded, setCoverageLoaded] = useState(false), [paySelf, setPaySelf] = useState(record.payNetworkFeeSelf ?? false);
  const dialog = useContext(TransactionDialogContext);
  useEffect(() => { let live = true; setCoverageLoaded(false); setRouter(undefined); void api.read<Deployment>("/deployment").then(value => { if (live) setRouter(value.contract.toLowerCase() === record.deployment.contract.toLowerCase() ? value.router : undefined); }).catch(() => {}).finally(() => { if (live) setCoverageLoaded(true); }); return () => { live = false; }; }, [record.deployment.contract]);
  useEffect(() => { if (record.payNetworkFeeSelf !== undefined) setPaySelf(record.payNetworkFeeSelf); }, [record.payNetworkFeeSelf]);
  useEffect(() => { onBusyChange?.(task.busy); }, [task.busy, onBusyChange]);
  const setDialogBusy = compactReview ? dialog?.setBusy : undefined;
  useEffect(() => { setDialogBusy?.(task.busy || wallet.busy); return () => setDialogBusy?.(false); }, [task.busy, wallet.busy, setDialogBusy]);
  const poll = useRef<() => void>(() => {});
  const autoStarted = useRef(false);
  useEffect(() => { if (autoSubmit && coverageLoaded && !autoStarted.current && record.progress === "review") { autoStarted.current = true; void task.run(() => submit(false)); } }, [autoSubmit, coverageLoaded, record.id]);
  poll.current = () => { if (record.progress === "checking" && !task.busy && !wallet.busy) void task.run(check); };
  useEffect(() => { const timer = window.setInterval(() => poll.current(), 4000); return () => clearInterval(timer); }, []);
  async function save(next: Operation) { const value = await journal.save(next); onChange(value); return value; }
  async function assertDeployment() {
    const active = await api.read<{ chainId: number; contract: string }>("/deployment");
    if (record.deployment.chainId !== active.chainId || record.deployment.contract.toLowerCase() !== active.contract.toLowerCase()) throw new Error("This operation belongs to an abandoned deployment.");
  }
  const sellerClaim = singleApproval && wallet.session?.kind === "builtin" && (record.action?.kind === "withdrawSeller" || record.action?.kind === "claimResponseTimeout");
  const recoverableSellerAction = wallet.session?.kind === "builtin" && ["withdrawSeller", "claimResponseTimeout", "reserveDelivery", "publishDelivery"].includes(record.action?.kind ?? "");
  async function submit(manual = true) {
    try {
      await assertDeployment();
      if (recoverableSellerAction && record.action && await reconcileAction(api, record.account, record.action)) {
        await save({ ...record, progress: "finalized" }); await onFinalized?.(); return;
      }
      if (manual) onApprove?.(!coversFees || paySelf, router);
      await beforeSubmit?.();
      if (coversFees && !paySelf) await sponsor(); else await send();
    } catch (error) { onSubmissionError?.(); throw error; }
  }
  async function retryUncertain() {
    await assertDeployment();
    // These order transitions can succeed only once. A late relay cannot
    // publish different content or pay the seller twice.
    if (record.action && await reconcileAction(api, record.account, record.action)) { await save({ ...record, progress: "finalized" }); await onFinalized?.(); return; }
    try { const job = await api.read<{ id: string }>(`/relay/jobs/by-nonce/${record.account}/${record.relayNonce}`); await save({ ...record, relayJobId: job.id }); return; }
    catch (error) { if (!(error instanceof ApiError) || error.code !== "RELAY_JOB_NOT_FOUND") throw error; }
    onSubmissionError?.();
    onChange(await prepareOperation(api, { ...record, progress: "reverted" }, record.action!, record.payNetworkFeeSelf));
  }
  async function check() {
    await assertDeployment();
    if (record.relayJobId) {
      const job = await api.read<{ status: string; transactionHash: string | null }>(`/relay/jobs/${record.relayJobId}`);
      if (job.status === "finalized") { await save({ ...record, progress: "finalized", activeHash: job.transactionHash ?? undefined }); await onFinalized?.(); }
      else if (job.status === "failed") {
        if (recoverableSellerAction && record.action && await reconcileAction(api, record.account, record.action)) { await save({ ...record, progress: "finalized" }); await onFinalized?.(); }
        else { onSubmissionError?.(); await save({ ...record, progress: "reverted", relayJobId: undefined }); }
      }
      return;
    }
    if (record.relayNonce && !record.requestId) {
      try {
        const job = await api.read<{ id: string; status: string }>(`/relay/jobs/by-nonce/${record.account}/${record.relayNonce}`);
        await save({ ...record, relayJobId: job.id });
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "RELAY_JOB_NOT_FOUND") throw error;
        if (record.action && await reconcileAction(api, record.account, record.action)) {
          await save({ ...record, progress: "finalized" }); await onFinalized?.();
        } else if (record.relayExpiresAt && Date.now() >= Date.parse(record.relayExpiresAt)) {
          await save({ ...record, progress: "review", relayNonce: undefined, relayExpiresAt: undefined });
        }
      }
      return;
    }
    if (record.requestId) {
      const result = await api.request<{ status: string; orderId?: string; order?: { buyer: string; requestId: string; buyerReceiving: Receiving } }>(`/orders/recover/${record.requestId}`);
      if (result.status === "finalized") {
        if (!result.order || !purchaseMatches(record, result.order)) throw new Error(`This request was used by another receiving identity. Open order #${result.orderId} from Purchases; do not retry this purchase.`);
        await save({ ...record, progress: "finalized", orderId: result.orderId }); await onFinalized?.(); return;
      }
    }
    const hash = record.activeHash;
    if (!hash) {
      if (record.action && record.progress === "checking" && await reconcileAction(api, record.account, record.action)) {
        await save({ ...record, progress: "finalized", transaction: record.publication ? record.transaction : undefined }); await onFinalized?.();
      }
      return;
    }
    const isApproval = record.action?.kind === "approve" || record.action?.kind === "approveArbitrationFee";
    const target = isApproval ? `?token=${record.transaction!.to}` : "";
    const result = await api.request<{ status: string }>(`/transactions/${hash}${target}`);
    if (result.status === "finalized_revert") await save({ ...record, progress: "reverted" });
    else if (result.status === "finalized_success" && record.action?.kind !== "purchase") {
      await save({ ...record, progress: isApproval ? "draft" : "finalized", transaction: record.publication ? record.transaction : undefined }); await onFinalized?.();
    }
  }
  async function send() {
    await assertDeployment();
    if (!record.action || !record.transaction) throw new Error("Review the transaction first.");
    const fresh = await api.request<PreparedTx>("/transactions/prepare", record.action);
    const tx = record.transaction;
    if (sellerClaim && (tx.chainId !== 10143 || tx.to.toLowerCase() !== record.deployment.contract.toLowerCase() || tx.value !== "0" || tx.data.toLowerCase() !== sellerClaimAbi.encodeFunctionData(record.action.kind, [record.orderId]).toLowerCase())) throw new Error("Claim details changed. Review the claim again.");
    if (fresh.to !== tx.to || fresh.data !== tx.data || fresh.value !== tx.value || fresh.nonce !== tx.nonce || BigInt(fresh.maxFeePerGas) > BigInt(tx.maxFeePerGas) || BigInt(fresh.gas) > BigInt(tx.gas)) throw new Error("Transaction details changed. Prepare and review again.");
    let pending = record;
    await wallet.runOperation(async (session, isCurrent) => {
      if (session.address.toLowerCase() !== record.account || !isCurrent()) throw new Error("Wallet changed.");
      const reviewed: ReviewedTransaction = { chainId: 10143, to: tx.to as `0x${string}`, data: tx.data as `0x${string}`, value: BigInt(tx.value), nonce: tx.nonce, gas: BigInt(tx.gas), maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) };
      if (session.signTransaction) {
        let raw: string;
        let release: (() => void) | undefined;
        try {
          release = sellerClaim ? session.authorizePurchase?.({ transactions: [{ transaction: reviewed, maxNetworkFee: reviewed.gas * reviewed.maxFeePerGas }] }) : undefined;
          raw = await session.signTransaction(reviewed);
        }
        finally { release?.(); }
        const hash = Transaction.from(raw).hash!;
        // Local signing cannot broadcast. Only enter checking once its hash is
        // durable, so locking or rejecting before signing remains retryable.
        pending = await save({ ...pending, payNetworkFeeSelf: true, progress: "checking", activeHash: hash, hashes: [...pending.hashes, hash] });
        if (!isCurrent()) throw new Error("Wallet changed. Check the original operation after reconnecting.");
        await api.request("/transactions/broadcast", { action: record.action, raw });
      } else if (session.sendTransaction) {
        pending = await save({ ...record, payNetworkFeeSelf: true, activeHash: undefined, progress: "checking" });
        let hash: string;
        try { hash = await session.sendTransaction(reviewed); }
        catch (error) {
          if (walletErrorKind(error) === "rejected") await save({ ...pending, progress: "review" });
          throw error; // Every other provider failure remains uncertain.
        }
        await save({ ...pending, activeHash: hash, hashes: [...pending.hashes, hash] });
      } else throw new Error("This wallet cannot submit transactions.");
    });
  }
  async function sponsor() {
    await assertDeployment();
    if (!router || !record.action || !canRelay(record.action) || record.progress !== "review") throw new Error("This action is not available for relaying.");
    const fresh = await api.request<{ chainId: number; to: string; data: string; value: string }>("/transactions/request", record.action);
    if (sellerClaim && fresh.data.toLowerCase() !== sellerClaimAbi.encodeFunctionData(record.action.kind, [record.orderId]).toLowerCase()) throw new Error("Claim details changed. Review the claim again.");
    if (fresh.chainId !== 10143 || fresh.to.toLowerCase() !== record.deployment.contract.toLowerCase() || fresh.value !== "0" ||
        record.transaction && (fresh.data !== record.transaction.data || fresh.to !== record.transaction.to)) throw new Error("Action details changed. Review them again.");
    const now = Math.floor(Date.now() / 1000), nonce = randomId(), validAfter = "0", validBefore = String(now + 3600);
    const fields = [{ name: "actor", type: "address" }, { name: "escrow", type: "address" }, { name: "actionHash", type: "bytes32" },
      { name: "nonce", type: "bytes32" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }];
    const typedData: ReviewedTypedData = { domain: { name: "PayUnlockActionRouter", version: "1", chainId: 10143, verifyingContract: router as `0x${string}` },
      primaryType: "PayUnlockAction", types: { PayUnlockAction: fields },
      message: { actor: record.account, escrow: record.deployment.contract, actionHash: keccak256(fresh.data), nonce, validAfter, validBefore },
      review: { title: actionDescription(record.action), asset: "token", amount: "0", rawValue: "0", decimals: 0,
        recipient: record.deployment.contract, expiresAt: new Date(Number(validBefore) * 1000).toISOString() } };
    const signature = await wallet.runOperation(async (session, isCurrent) => {
      if (!session.signTypedData || !isCurrent() || session.address.toLowerCase() !== record.account) throw new Error("This wallet cannot sign action authorizations. Use direct submission.");
      const release = sellerClaim ? session.authorizePurchase?.({ transactions: [], typedData }) : undefined;
      let signed: string;
      try { signed = await session.signTypedData(typedData); } finally { release?.(); }
      if (!isCurrent() || verifyTypedData(typedData.domain, typedData.types, typedData.message, signed).toLowerCase() !== record.account) throw new Error("Wallet changed while signing.");
      return signed;
    });
    const pending = await save({ ...record, payNetworkFeeSelf: false, progress: "checking", activeHash: undefined, relayNonce: nonce,
      relayExpiresAt: new Date(Number(validBefore) * 1000).toISOString() });
    const job = await api.request<{ id: string }>("/relay/payments", { kind: "action", chainId: 10143, escrow: record.deployment.contract, router,
      actionData: fresh.data, authorization: { actor: record.account, nonce, validAfter, validBefore, signature } });
    await save({ ...pending, relayJobId: job.id });
  }
  const coversFees = !buyerView && !!router && canRelay(record.action) && (!record.transaction || record.transaction.value === "0" && record.transaction.to.toLowerCase() === record.deployment.contract.toLowerCase());
  async function changeFeeMode(selfPay: boolean) {
    if (record.progress !== "review" || record.relayNonce || !coversFees) return;
    let transaction = record.transaction;
    if (selfPay && !transaction) {
      try { transaction = await api.request<PreparedTx>("/transactions/prepare", record.action!); }
      catch (error) { if (error instanceof ApiError && error.code === "INSUFFICIENT_MON_FOR_PAYMENT_AND_GAS") throw new Error("Not enough MON for network fees. Top up MON or keep Network fee covered selected.", { cause: error }); throw error; }
    }
    await save({ ...record, transaction, payNetworkFeeSelf: selfPay });
    setPaySelf(selfPay);
  }
  const orderPath = record.orderId ? record.requestId || location.pathname.startsWith("/purchases/") ? `/purchases/${record.orderId}` : location.pathname.startsWith("/sales/") ? `/sales/orders/${record.orderId}` : location.pathname.startsWith("/arbitration/") ? `/arbitration/${record.orderId}` : undefined : undefined;
  const uncertainRetry = recoverableSellerAction && record.progress === "checking" && !!record.relayNonce && !record.relayJobId && !record.activeHash;
  if (compactReview) return <TransactionReview record={record} summary={summary} subject={subject} confirmLabel={confirmLabel} orderPath={orderPath} canCoverFees={coversFees} checkingCoverage={!buyerView && !coverageLoaded} selfPay={!coversFees || paySelf} busy={task.busy || wallet.busy} error={task.error} singleApproval={singleApproval} maximumFee={maximumFee} onFeeChange={value => void task.run(() => changeFeeMode(value))} onConfirm={() => void task.run(() => submit())} onCheck={() => void task.run(check)} onRetry={uncertainRetry ? () => void task.run(retryUncertain) : onRetry ? () => void task.run(onRetry) : undefined} retryPending={uncertainRetry} retryLabel={uncertainRetry ? "Try again" : retryLabel} />;
  if (buyerView) return <section className="transaction-panel buyer-transaction"><p role="status">{record.progress === "checking" ? "Waiting for confirmation..." : record.progress === "reverted" ? "The transaction did not complete. Return to review before retrying." : "Review and confirm"}</p>
    {record.transaction && <><p>Maximum network fee: <strong>{formatUnits(BigInt(record.transaction.gas) * BigInt(record.transaction.maxFeePerGas), 18)} MON</strong></p>{record.progress === "review" && <Button icon={ButtonSend} disabled={task.busy || wallet.busy} onClick={() => void task.run(send)}>{record.action?.kind === "approve" ? "Approve token payment" : "Confirm payment"}</Button>}</>}
    {record.progress === "checking" && <Button icon={ButtonRefreshCw} variant="secondary" disabled={task.busy || wallet.busy} onClick={() => void task.run(check)}>Check status</Button>}
    <details><summary>Transaction details</summary>{record.requestId && <p className="address">Purchase reference: {record.requestId}</p>}{record.transaction && <p className="address">Destination: {record.transaction.to}</p>}{record.hashes.map(hash => <p className="address" key={hash}>Transaction: {hash}</p>)}</details><Feedback {...task} />
  </section>;
  return <section className="transaction-panel"><p role="status">{record.progress === "checking" ? record.relayJobId ? "Waiting for relayer and finalized action" : "Checking transaction" : record.progress === "finalized" ? "Finalized on Monad Testnet" : record.progress === "reverted" ? "Transaction reverted. Review before retrying." : "Review transaction"}</p>{orderPath && <Link to={orderPath}>Open order #{record.orderId}</Link>}
    {record.progress === "review" && router && canRelay(record.action) && <><p>{actionDescription(record.action)} A relayer can pay the MON network fee for this action.</p><Button icon={ButtonSend} disabled={task.busy || wallet.busy} onClick={() => void task.run(sponsor)}>Sign action for a relayer</Button></>}
    {record.progress === "review" && !record.transaction && record.action && <Button variant="secondary" disabled={task.busy || wallet.busy} onClick={() => void task.run(async () => save({ ...record, transaction: await api.request<PreparedTx>("/transactions/prepare", record.action!), progress: "review" }))}>Pay network fee myself</Button>}
    {record.transaction && <><dl className="terms"><dt>Action</dt><dd>{actionDescription(record.action)}</dd><dt>Value</dt><dd>{formatUnits(record.transaction.value, 18)} MON</dd><dt>Maximum gas cost</dt><dd>{formatUnits(BigInt(record.transaction.gas) * BigInt(record.transaction.maxFeePerGas), 18)} MON</dd><dt>MON balance</dt><dd>{formatUnits(record.transaction.balance, 18)} MON</dd><dt>Destination</dt><dd>{record.transaction.to}</dd></dl>{record.progress === "review" && <Button icon={ButtonSend} disabled={task.busy || wallet.busy} onClick={() => void task.run(send)}>Confirm and send transaction</Button>}</>}
    {record.progress === "checking" && <Button icon={ButtonRefreshCw} variant="secondary" disabled={task.busy || wallet.busy} onClick={() => void task.run(check)}>Check status</Button>}
    {record.hashes.map(hash => <p className="address" key={hash}>Transaction: {hash}</p>)}<Feedback {...task} />
  </section>;
}
export async function prepareOperation(api: ReturnType<typeof useCommerce>, record: Operation, action: Action, selfPay = false) {
  let transaction: PreparedTx | undefined;
  try { transaction = await api.request<PreparedTx>("/transactions/prepare", action); }
  catch (error) {
    if (selfPay && error instanceof ApiError && error.code === "INSUFFICIENT_MON_FOR_PAYMENT_AND_GAS") throw new Error("Not enough MON for network fees. Top up MON or switch off Pay network fee myself.", { cause: error });
    if (!(error instanceof ApiError) || error.code !== "INSUFFICIENT_MON_FOR_PAYMENT_AND_GAS" || !canRelay(action) ||
        !(await api.read<Deployment>("/deployment")).router) throw error;
    const request = await api.request<{ to: string; value: string }>("/transactions/request", action);
    if (request.value !== "0" || request.to.toLowerCase() !== record.deployment.contract.toLowerCase()) throw error;
  }
  return journal.save({ ...record, ...(record.progress === "reverted" ? { relayJobId: undefined, relayNonce: undefined, relayExpiresAt: undefined } : {}), action, transaction, activeHash: undefined, progress: "review" });
}
