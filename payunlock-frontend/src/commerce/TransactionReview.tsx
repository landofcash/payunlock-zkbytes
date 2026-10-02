import { CheckCircle2, CircleAlert, Clock, Send, RefreshCw } from "lucide-react";
import { formatUnits } from "ethers";
import { useContext, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import type { Operation } from "./purchase-journal";
import { OrderAmount } from "./OrderPresentation";
import { TransactionDialogContext } from "./transaction-dialog-context";
import { transactionReviewCopy } from "./transaction-review-copy";

export function TransactionReview({ record, summary, subject, confirmLabel, orderPath, canCoverFees, checkingCoverage, selfPay, busy, error, onFeeChange, onConfirm, onCheck, onRetry, retryLabel }: {
  record: Operation; summary?: ReactNode; subject?: string; confirmLabel?: string; orderPath?: string; canCoverFees: boolean; checkingCoverage: boolean; selfPay: boolean;
  busy: boolean; error: string; onFeeChange(value: boolean): void; onConfirm(): void; onCheck(): void;
  onRetry?: () => void; retryLabel?: string;
}) {
  const dialog = useContext(TransactionDialogContext), copy = transactionReviewCopy(record.action);
  const reviewing = record.progress === "review", pending = record.progress === "checking", complete = record.progress === "finalized" || record.progress === "draft";
  const tx = record.transaction, fee = tx ? BigInt(tx.gas) * BigInt(tx.maxFeePerGas) : undefined;
  const lowBalance = selfPay && tx && fee !== undefined && BigInt(tx.balance) < BigInt(tx.value) + fee;
  const StatusIcon = complete ? CheckCircle2 : pending ? Clock : CircleAlert;
  return <section className="transaction-review" aria-busy={busy || undefined}>
    <div className="transaction-review-summary">
      {subject && <h3>{subject}</h3>}
      {summary ?? <>{record.configuration && (record.action?.kind === "purchase" || record.action?.kind === "approve") && <OrderAmount token={record.configuration.terms.token} price={record.configuration.terms.price} />}{(record.action?.kind === "requestArbitration" || record.action?.kind === "approveArbitrationFee") && <OrderAmount token={record.action.expectedFeeAsset} price={record.action.expectedFee} />}<p>{copy.description}</p></>}
      {record.orderId && orderPath && <Link className="transaction-review-reference" to={orderPath}>Order #{record.orderId}</Link>}
    </div>
    {copy.warning && reviewing && <p className="transaction-review-warning"><CircleAlert size={18} aria-hidden="true" /><span>{copy.warning}</span></p>}
    {!reviewing && <p className={`transaction-review-status ${complete ? "is-complete" : pending ? "is-pending" : "is-failed"}`} role="status"><StatusIcon size={18} aria-hidden="true" /><span>{complete ? "Transaction confirmed." : pending ? "Waiting for confirmation. You can close this dialog and check again later." : "The transaction did not complete. Review it again before retrying."}</span></p>}
    {reviewing && <div className="transaction-review-fees">
      {checkingCoverage ? <p className="muted" role="status">Checking network fee options…</p> : <p className="transaction-review-fee-label">{selfPay ? "You pay network fees in MON." : "Network fee covered."}</p>}
      {canCoverFees && <label className="transaction-fee-switch buyer-fee-switch"><input type="checkbox" role="switch" checked={selfPay} disabled={busy || !!record.relayNonce} onChange={e => onFeeChange(e.currentTarget.checked)} /><span>Pay network fee myself</span></label>}
      {selfPay && fee !== undefined && <dl className="transaction-review-cost"><dt>Maximum network fee</dt><dd>{formatUnits(fee, 18)} MON</dd><dt>Your MON balance</dt><dd>{formatUnits(tx!.balance, 18)} MON</dd></dl>}
      {lowBalance && <p className="transaction-review-error" role="alert">Not enough MON for this transaction. Top up MON{canCoverFees ? " or switch off Pay network fee myself" : ""}.</p>}
      <p className="transaction-review-hint">{selfPay ? "Your wallet will ask you to confirm a transaction." : "Your wallet will ask you to sign this action."}</p>
    </div>}
    <details className="transaction-review-details"><summary>Transaction details</summary><dl>
      {tx && <><dt>Transaction value</dt><dd>{formatUnits(tx.value, 18)} MON</dd><dt>Destination</dt><dd><code>{tx.to}</code></dd></>}
      {record.requestId && <><dt>Purchase reference</dt><dd><code>{record.requestId}</code></dd></>}
      {record.productId && <><dt>Offer reference</dt><dd><code>{record.productId}</code></dd></>}
      {record.action?.kind === "requestArbitration" && <><dt>Arbitrator</dt><dd><code>{record.action.wallet}</code></dd><dt>Key version</dt><dd>{record.action.expectedKeyVersion}</dd></>}
      {record.action?.kind === "approveArbitrationFee" && <><dt>Arbitrator</dt><dd><code>{record.action.arbitrator}</code></dd></>}
      {record.hashes.map(hash => <div key={hash}><dt>Transaction hash</dt><dd><code>{hash}</code></dd></div>)}
      {!tx && !record.requestId && !record.hashes.length && <><dt>Contract</dt><dd><code>{record.deployment.contract}</code></dd></>}
    </dl></details>
    {error && <p className="transaction-review-error" role="alert"><CircleAlert size={16} aria-hidden="true" />{error}</p>}
    <footer className="transaction-review-footer">
      {dialog && <Button variant="secondary" disabled={busy} onClick={dialog.close}>{reviewing ? "Cancel" : "Close"}</Button>}
      {reviewing && <Button icon={Send} loading={busy} disabled={checkingCoverage || !!record.relayNonce || !!lowBalance || (selfPay && !tx)} onClick={onConfirm}>{confirmLabel ?? copy.label}</Button>}
      {pending && <Button icon={RefreshCw} iconSpinning={busy} onClick={onCheck}>Check status</Button>}
      {record.progress === "reverted" && onRetry && <Button icon={RefreshCw} loading={busy} onClick={onRetry}>{retryLabel ?? "Review again"}</Button>}
    </footer>
  </section>;
}
