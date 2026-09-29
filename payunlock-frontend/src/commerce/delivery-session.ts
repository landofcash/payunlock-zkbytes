import type { ZkbytesClient } from "@zkbytes/sdk";
import { canonical } from "@/crypto/encoding";
import type { DraftCredential } from "@/crypto/draft-envelope";
import { pendingId, type Pending, type Progress } from "./journal";
import type { PreparedDelivery } from "./protocol";
import type { BulkEntry, BulkManifest } from "./bulk-journal";

// Delivery content exists only in this mounted page. Reloading intentionally loses it.
export class DeliverySession {
  private pending?: Pending;
  async prepare(prepared: PreparedDelivery, _credential: DraftCredential, current: () => boolean) {
    if (!current()) throw new Error("Wallet changed.");
    this.pending = { ...prepared, version: 1, progress: "prepared", tx1: null, tx2: null };
    return pendingId(prepared);
  }
  async restore(id: string, _credential?: DraftCredential) { void _credential;
    if (!this.pending || pendingId(this.pending) !== id) throw new Error("Prepare the delivery again.");
    return this.pending;
  }
  async update(id: string, _credential: DraftCredential, next: Progress, hash: string | null = null) {
    const p = await this.restore(id);
    p.progress = next;
    if (next === "tx1-pending" && hash) p.tx1 = hash;
    if (next === "tx2-pending" && hash) p.tx2 = hash;
  }
  async upload(id: string, credential: DraftCredential, client: ZkbytesClient, current: () => boolean) {
    const p = await this.restore(id);
    if (!current()) throw new Error("Wallet changed.");
    p.progress = "upload-uncertain";
    const result = await client.upload(p.item);
    if (!current()) throw new Error("Wallet changed.");
    if (!("state" in result)) p.progress = "uploaded";
    return result;
  }
  async recoverUpload(id: string, _credential: DraftCredential, client: ZkbytesClient, current: () => boolean) {
    const p = await this.restore(id);
    if (!current()) throw new Error("Wallet changed.");
    const result = await client.recoverUpload(p.item.seed, p.record.creator);
    if (!current()) throw new Error("Wallet changed.");
    if (result.outcome === "active") {
      if (canonical(result.item) !== canonical(p.item)) throw new Error("Uploaded content differs from this delivery.");
      p.progress = "uploaded";
    }
    return result.outcome;
  }
  async cleanupConfirmed(id: string, hash: string, _credential?: DraftCredential) { void _credential;
    if (!this.pending) return true;
    if (pendingId(this.pending) !== id || this.pending.recordHash !== hash) return false;
    this.clear(); return true;
  }
  clear() { this.pending = undefined; }
}

export class BulkDeliverySession {
  private manifest?: BulkManifest;
  private entries = new Map<string, BulkEntry>();
  async create(manifest: BulkManifest, entries: BulkEntry[], _credential: DraftCredential, current: () => boolean) {
    if (!current()) throw new Error("Wallet changed.");
    this.manifest = structuredClone(manifest);
    this.entries = new Map(entries.map(e => [e.order.orderId, structuredClone(e)]));
  }
  async load(id: string, _credential?: DraftCredential) { void _credential;
    if (this.manifest?.id !== id) throw new Error("Select the orders and prepare content again.");
    return structuredClone(this.manifest);
  }
  async entry(id: string, orderId: string, _credential?: DraftCredential) { void _credential;
    if (this.manifest?.id !== id || !this.entries.has(orderId)) throw new Error("Prepare this order again.");
    return structuredClone(this.entries.get(orderId)!);
  }
  async save(manifest: BulkManifest, _credential?: DraftCredential) { void _credential; this.manifest = structuredClone(manifest); }
  async saveEntry(id: string, entry: BulkEntry, _credential?: DraftCredential) { void _credential;
    if (this.manifest?.id !== id) throw new Error("Delivery session changed.");
    this.entries.set(entry.order.orderId, structuredClone(entry));
  }
  clear() { this.manifest = undefined; this.entries.clear(); }
}
