import {z} from "zod";
import type {LocalStore} from "@/storage/local-store";
import type {Action, Configuration, PreparedTx, Receiving} from "./client";
import type {ReceivingContext} from "./protocol";

export type Operation = {
  id: string;
  account: string;
  deployment: { chainId: 10143; contract: string };
  productId?: string;
  requestId?: string;
  receiving?: Receiving;
  context?: ReceivingContext;
  configuration?: Configuration;
  payNetworkFeeSelf?: boolean;
  action?: Action;
  transaction?: PreparedTx;
  relayJobId?: string;
  relayNonce?: string;
  relayFailureReason?: string;
  relayExpiresAt?: string;
  activeHash?: string;
  hashes: string[];
  progress: "draft" | "review" | "checking" | "reverted" | "finalized";
  publication?: { visibility: "public" | "hidden"; revision: number };
  orderId?: string;
  version: number
};
const envelope = z.array(z.object({
  id: z.string(),
  account: z.string(),
  deployment: z.object({chainId: z.literal(10143), contract: z.string()}),
  version: z.number().int(),
  hashes: z.array(z.string()),
  progress: z.enum(["draft", "review", "checking", "reverted", "finalized"])
}).passthrough());

// Public transaction metadata only: no signatures, encryption keys, object seeds or plaintext delivery.
export class PurchaseJournal {
  constructor(private store: LocalStore) {
  }

  async list(account: string): Promise<Operation[]> {
    return envelope.parse(await this.store.get(this.key(account)) ?? []) as Operation[];
  }

  async save(record: Operation) {
    const key = this.key(record.account), before = await this.store.get(key),
      rows = envelope.parse(before ?? []) as Operation[];
    const existing = rows.find(r => r.id === record.id);
    if (existing && existing.version !== record.version) throw new Error("Operation changed in another tab. Reload before continuing.");
    if (existing && (existing.requestId !== record.requestId || JSON.stringify(existing.context) !== JSON.stringify(record.context) || existing.deployment.contract !== record.deployment.contract)) throw new Error("Purchase identity cannot change.");
    const next = {...record, version: record.version + 1};
    await this.store.compareAndSwap(key, before, [...rows.filter(r => r.id !== record.id), next]);
    return next;
  }

  async remove(record: Pick<Operation, "account" | "id" | "version">) {
    const key = this.key(record.account), before = await this.store.get(key),
      rows = envelope.parse(before ?? []) as Operation[];
    const existing = rows.find(row => row.id === record.id);
    if (!existing) return;
    if (existing.version !== record.version) throw new Error("Operation changed in another tab. Reload before removing it.");
    if (existing.progress === "checking" || existing.progress === "finalized" || existing.orderId)
      throw new Error("Check the payment status before removing this checkout.");
    await this.store.compareAndSwap(key, before, rows.filter(row => row.id !== record.id));
  }

  // This is the journal schema namespace, independent of the escrow version.
  private key(account: string) {
    return `commerce-v4:${account.toLowerCase()}`;
  }
}

export function purchaseMatches(record: Operation, order: {
  buyer: string;
  requestId: string;
  buyerReceiving: Receiving
}) {
  return record.account === order.buyer && record.requestId === order.requestId && record.receiving?.nonce === order.buyerReceiving.nonce && record.receiving.publicKey === order.buyerReceiving.publicKey;
}
