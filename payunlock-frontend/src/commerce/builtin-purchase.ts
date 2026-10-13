import {Transaction, ZeroAddress} from "ethers";
import type {LabWalletSession} from "@/wallet/types";
import type {ReviewedTransaction} from "@/wallet/managed-session";
import type {PurchaseAuthorization} from "@/wallet/purchase-authorization";
import type {Action, Asset, Deployment, PreparedTx} from "./client";
import {type Operation, PurchaseJournal, purchaseMatches} from "./purchase-journal";
import {assertPurchaseSignature, buildPurchaseAuthorization} from "./token-authorization";

type Client = { read<T>(path: string): Promise<T>; request<T>(path: string, body?: unknown): Promise<T> };
export type PurchasePlan = {
  record: Operation;
  scope: PurchaseAuthorization;
  maxNetworkFee: bigint;
  packet?: ReturnType<typeof buildPurchaseAuthorization>;
  approval?: PreparedTx;
  purchase?: PreparedTx
};
const transaction = (tx: PreparedTx): ReviewedTransaction => ({
  chainId: tx.chainId,
  to: tx.to as `0x${string}`,
  data: tx.data as `0x${string}`,
  value: BigInt(tx.value),
  nonce: tx.nonce,
  gas: BigInt(tx.gas),
  maxFeePerGas: BigInt(tx.maxFeePerGas),
  maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas)
});
const fee = (tx: PreparedTx) => BigInt(tx.gas) * BigInt(tx.maxFeePerGas);
const action = (record: Operation, kind: "approve" | "purchase"): Action => ({
  kind,
  requestId: record.requestId!,
  expectedTerms: record.configuration!.expectedTerms
});

export async function prepareBuiltinPurchase(api: Client, record: Operation, asset: Asset, title: string): Promise<PurchasePlan> {
  if (record.progress === "checking" || record.progress === "finalized") throw new Error("Check the current payment status before continuing.");
  const config = record.configuration!;
  if (!record.receiving || !record.requestId || !config.allowed || config.status !== 1) throw new Error("This checkout is not ready for payment.");
  if (BigInt(asset.balance) < BigInt(config.terms.price)) throw new Error("Top up your payment balance to continue.");
  if (config.authorizationMode === "eip3009-receive" && !record.payNetworkFeeSelf) {
    const packet = buildPurchaseAuthorization({
      configuration: config,
      deployment: await api.read<Deployment>("/deployment"),
      asset,
      buyer: record.account,
      requestId: record.requestId,
      receiving: record.receiving,
      title
    });
    return {record, packet, scope: {transactions: [], typedData: packet.typedData}, maxNetworkFee: 0n};
  }
  const needsApproval = config.terms.token !== ZeroAddress && BigInt(asset.allowance) < BigInt(config.terms.price);
  const approval = needsApproval ? await api.request<PreparedTx>("/transactions/prepare", action(record, "approve")) : undefined;
  // An allowance-dependent purchase cannot be estimated yet. This is an
  // explicit upper bound, not a gas estimate; it is checked after approval.
  const purchase = approval ? {
      ...approval, ...await api.request<Pick<PreparedTx, "chainId" | "to" | "data" | "value">>("/transactions/request", action(record, "purchase")),
      nonce: approval.nonce + 1,
      gas: "500000"
    }
    : await api.request<PreparedTx>("/transactions/prepare", action(record, "purchase"));
  const maxNetworkFee = fee(purchase) + (approval ? fee(approval) : 0n);
  if (BigInt(asset.nativeBalance) < BigInt(purchase.value) + maxNetworkFee) throw new Error("Top up MON to cover the payment and maximum network fees.");
  return {
    record,
    approval,
    purchase,
    maxNetworkFee,
    scope: {
      transactions: [approval, purchase].filter((tx): tx is PreparedTx => !!tx).map(tx => ({
        transaction: transaction(tx),
        maxNetworkFee: fee(tx)
      }))
    }
  };
}

export async function checkBuiltinPurchase(api: Client, journal: PurchaseJournal, record: Operation): Promise<Operation> {
  if (record.progress !== "checking") return record;
  const active = await api.read<Deployment>("/deployment");
  if (active.chainId !== record.deployment.chainId || active.contract.toLowerCase() !== record.deployment.contract.toLowerCase()) throw new Error("This checkout belongs to an abandoned deployment.");
  const recovered = await api.request<{
    status: string;
    orderId?: string;
    order?: Parameters<typeof purchaseMatches>[1]
  }>(`/orders/recover/${record.requestId}`);
  if (recovered.status === "finalized") {
    if (!recovered.order || !purchaseMatches(record, recovered.order)) throw new Error("This purchase belongs to another receiving identity. Open Purchases to inspect it.");
    return journal.save({...record, progress: "finalized", orderId: recovered.orderId});
  }
  if (record.relayJobId) {
    const job = await api.read<{
      status: string;
      transactionHash: string | null;
      failureReason: string | null
    }>(`/relay/jobs/${record.relayJobId}`);
    if (job.status === "failed") return journal.save({
      ...record,
      progress: "reverted",
      relayFailureReason: job.failureReason ?? undefined
    });
    if (job.transactionHash && job.transactionHash !== record.activeHash) return journal.save({
      ...record,
      activeHash: job.transactionHash,
      hashes: [...record.hashes, job.transactionHash]
    });
  } else if (record.activeHash) {
    const approval = record.action?.kind === "approve";
    const result = await api.request<{
      status: string
    }>(`/transactions/${record.activeHash}${approval ? `?token=${record.transaction!.to}` : ""}`);
    if (result.status === "finalized_revert") return journal.save({...record, progress: "reverted"});
    if (approval && result.status === "finalized_success") return journal.save({
      ...record,
      progress: "draft",
      action: undefined,
      transaction: undefined,
      activeHash: undefined
    });
  }
  return record;
}

export async function retryBuiltinPurchase(api: Client, journal: PurchaseJournal, record: Operation): Promise<Operation> {
  if (record.progress !== "checking" || !record.relayNonce || record.relayJobId || record.activeHash || record.action) throw new Error("Check the current payment status before retrying.");
  const checked = await checkBuiltinPurchase(api, journal, record);
  if (checked.progress === "finalized") return checked;
  // Keep the purchase identity: the escrow rejects duplicate buyer/requestId
  // pairs even if the original relay submission completes after this check.
  // Prepare the retry in memory. Keep the saved attempt pending until the new
  // authorization is submitted, so a preparation error still allows recovery.
  return {
    ...checked,
    progress: "draft",
    relayNonce: undefined,
    relayExpiresAt: undefined,
    relayFailureReason: undefined
  };
}

export async function executeBuiltinPurchase(input: {
  api: Client;
  journal: PurchaseJournal;
  plan: PurchasePlan;
  session: LabWalletSession;
  current(): boolean;
  onChange(record: Operation): void;
  wait?(): Promise<void>
}) {
  const {api, journal, plan, session, current, onChange} = input;
  if (plan.record.progress === "checking" || plan.record.progress === "finalized") throw new Error("Check the current payment status before continuing.");
  const assertCurrent = () => {
    if (!current() || session.locked || session.address.toLowerCase() !== plan.record.account) throw new Error("Wallet locked or changed. Check purchase status before continuing.");
  };
  assertCurrent();
  if (session.kind !== "builtin" || !session.authorizePurchase) throw new Error("Choose an unlocked built-in wallet.");
  const active = await api.read<Deployment>("/deployment");
  if (active.chainId !== plan.record.deployment.chainId || active.contract.toLowerCase() !== plan.record.deployment.contract.toLowerCase()) throw new Error("This checkout belongs to an abandoned deployment.");
  assertCurrent();
  const release = session.authorizePurchase(plan.scope);
  let record = plan.record;
  const save = async (next: Operation) => {
    record = await journal.save(next);
    onChange(record);
  };
  try {
    if (plan.packet) {
      if (!session.signTypedData) throw new Error("This wallet cannot sign token payments.");
      const signature = await session.signTypedData(plan.packet.typedData);
      assertCurrent();
      assertPurchaseSignature(plan.packet.typedData, signature, record.account);
      await save({
        ...record,
        action: undefined,
        transaction: undefined,
        activeHash: undefined,
        relayJobId: undefined,
        relayNonce: plan.packet.nonce,
        progress: "checking"
      });
      assertCurrent();
      const job = await api.request<{ id: string }>("/relay/payments", {
        kind: "purchase",
        chainId: active.chainId,
        escrow: active.contract,
        router: active.router,
        intent: plan.packet.intent,
        authorization: {...plan.packet.authorization, signature}
      });
      await save({...record, relayJobId: job.id});
      return;
    }
    for (const kind of plan.approval ? ["approve", "purchase"] as const : ["purchase"] as const) {
      assertCurrent();
      const prepared = await api.request<PreparedTx>("/transactions/prepare", action(record, kind));
      assertCurrent();
      if (!session.signTransaction) throw new Error("This wallet cannot sign transactions.");
      // The wallet scope checks payload, nonce and fee bounds before signing.
      const raw = await session.signTransaction(transaction(prepared));
      const hash = Transaction.from(raw).hash!;
      await save({
        ...record,
        action: action(record, kind),
        transaction: prepared,
        activeHash: hash,
        hashes: [...record.hashes, hash],
        payNetworkFeeSelf: true,
        relayNonce: undefined,
        relayJobId: undefined,
        progress: "checking"
      });
      assertCurrent();
      await api.request("/transactions/broadcast", {action: record.action, raw});
      if (kind === "approve") {
        while (record.progress === "checking") {
          assertCurrent();
          const next = await checkBuiltinPurchase(api, journal, record);
          record = next;
          onChange(record);
          if (record.progress === "checking") await (input.wait?.() ?? new Promise<void>(resolve => setTimeout(resolve, 4000)));
        }
        if (record.progress !== "draft") throw new Error("Token approval failed. Review the purchase before trying again.");
      }
    }
  } finally {
    release();
  }
}
