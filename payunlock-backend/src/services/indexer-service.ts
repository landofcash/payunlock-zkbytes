import {z} from "zod";
import {ApiError, uint} from "../domain.js";
import {deploymentKey} from "./chain-service.js";

const metadata = z.object({
  chainId: z.number(),
  progressBlock: z.number().nullable(),
  sourceBlock: z.number().nullable(),
  isReady: z.boolean(),
  progressBlockTime: z.string().nullable()
});

export class IndexerService {
  readonly metrics = {requests: 0, failures: 0};

  constructor(private url?: string, private secret?: string, private fetcher: typeof fetch = fetch) {
  }

  async query<T>(query: string, variables: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    if (!this.url || !this.secret) throw new ApiError(503, "INDEXER_UNAVAILABLE");
    this.metrics.requests++;
    try {
      const response = await this.fetcher(this.url, {
        method: "POST", headers: {"content-type": "application/json", "x-hasura-admin-secret": this.secret},
        body: JSON.stringify({query, variables}), signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) throw new Error("indexer response");
      const body = await response.json() as { errors?: unknown; data?: unknown };
      if (body.errors) throw new Error("indexer query");
      return schema.parse(body.data);
    } catch {
      this.metrics.failures++;
      throw new ApiError(503, "INDEXER_UNAVAILABLE");
    }
  }

  async freshness(finalizedBlock?: number) {
    try {
      const result = await this.query("{_meta{chainId progressBlock sourceBlock isReady progressBlockTime}}", {}, z.object({_meta: z.array(metadata)}));
      const chain = result._meta.find(m => m.chainId === 10143);
      if (!chain || chain.progressBlock === null) return {status: "syncing", indexedBlock: null};
      return {
        status: chain.isReady ? "available" : "syncing",
        indexedBlock: chain.progressBlock,
        sourceBlock: chain.sourceBlock,
        lagBlocks: finalizedBlock === undefined ? null : Math.max(0, finalizedBlock - chain.progressBlock),
        lastProcessedAt: chain.progressBlockTime,
        finality: "provisional"
      };
    } catch {
      return {status: "unavailable", indexedBlock: null};
    }
  }

  async orders(wallet: string, role: "buyer" | "seller" | "arbitrator", after: string, limit: number, productKey?: string) {
    const result = await this.query(`query($deployment:String!,$wallet:String!,$after:numeric!,$limit:Int!){
      ChainOrder(where:{deployment:{_eq:$deployment},${role}:{_eq:$wallet},${productKey ? `productKey:{_eq:"${z.string().regex(/^0x[0-9a-f]{64}$/).parse(productKey)}"},` : ""}orderId:{_gt:$after}},order_by:{orderId:asc},limit:$limit){orderId}
    }`, {deployment: deploymentKey, wallet, after, limit}, z.object({ChainOrder: z.array(z.object({orderId: uint}))}));
    return result.ChainOrder.map(row => row.orderId);
  }

  async paymentAssets(after: string, limit: number) {
    const prefix = `${deploymentKey}:AssetAllowed:`;
    const result = await this.query(`query($prefix:String!,$after:String!,$limit:Int!){ChainConfiguration(where:{id:{_like:$prefix,_gt:$after}},order_by:{id:asc},limit:$limit){id}}`,
      {
        prefix: prefix + "%",
        after: prefix + after,
        limit
      }, z.object({ChainConfiguration: z.array(z.object({id: z.string()}))}));
    return result.ChainConfiguration.map(row => z.string().regex(/^0x[0-9a-f]{40}$/).parse(row.id.slice(prefix.length)));
  }

  async arbitrators(after: string, limit: number) {
    const result = await this.query(`query($deployment:String!,$after:String!,$limit:Int!){ChainArbitrator(where:{deployment:{_eq:$deployment},wallet:{_gt:$after}},order_by:{wallet:asc},limit:$limit){wallet}}`, {
      deployment: deploymentKey,
      after,
      limit
    }, z.object({ChainArbitrator: z.array(z.object({wallet: z.string().regex(/^0x[0-9a-f]{40}$/)}))}));
    return result.ChainArbitrator.map(row => row.wallet);
  }

  async products(ids: string[]) {
    const result = await this.query(`query($ids:[String!]!,$prefix:String!){
      ChainProduct(where:{id:{_in:$ids}}){id status data}
      ChainConfiguration(where:{id:{_like:$prefix}}){id data}
    }`, {ids, prefix: `${deploymentKey}:%`}, z.object({
      ChainProduct: z.array(z.object({id: z.string(), status: z.number(), data: z.string()})),
      ChainConfiguration: z.array(z.object({id: z.string(), data: z.string()})),
    }));
    const defaultsRow = result.ChainConfiguration.find(row => row.id === `${deploymentKey}:DefaultsChanged`);
    const defaults = defaultsRow ? z.object({
      reviewWindow: uint,
      responseWindow: uint
    }).parse(JSON.parse(defaultsRow.data)) : undefined;
    return new Map(result.ChainProduct.map(row => {
      const product = z.object({
        terms: z.object({
          token: z.string(), price: uint, hasEventEnd: z.boolean(), eventEnd: uint,
          hasReviewOverride: z.boolean(), reviewOverride: uint, commitmentWindow: uint
        })
      }).parse(JSON.parse(row.data));
      const terms = product.terms;
      const asset = result.ChainConfiguration.find(config => config.id === `${deploymentKey}:AssetAllowed:${terms.token.toLowerCase()}`);
      const allowed = asset ? z.object({allowed: z.boolean()}).parse(JSON.parse(asset.data)).allowed : false;
      return [row.id, {
        status: "indexed", finality: "provisional", productState: row.status, allowed,
        terms: {
          token: terms.token, price: terms.price, eventEnd: terms.hasEventEnd ? terms.eventEnd : null,
          reviewWindow: terms.hasReviewOverride ? terms.reviewOverride : defaults?.reviewWindow ?? null,
          responseWindow: defaults?.responseWindow ?? null, commitmentWindow: terms.commitmentWindow
        }
      }];
    }));
  }

  async history(orderId: string, after: string, limit: number) {
    const result = await this.query(`query($order:String!,$after:numeric!,$limit:Int!){
      ChainEvent(where:{order:{_eq:$order},position:{_gt:$after}},order_by:{position:asc},limit:$limit){id name blockNumber blockHash position transactionHash data}
    }`, {order: `${deploymentKey}:${orderId}`, after, limit}, z.object({
      ChainEvent: z.array(z.object({
        id: z.string(),
        name: z.string(),
        blockNumber: uint,
        blockHash: z.string(),
        position: uint,
        transactionHash: z.string(),
        data: z.string(),
      }))
    }));
    return result.ChainEvent.map(row => ({...row, data: JSON.parse(row.data) as unknown}));
  }

  async purchaseTransaction(orderId: string): Promise<string | null> {
    const result = await this.query(`query($order:String!){
      ChainEvent(where:{order:{_eq:$order},name:{_eq:"Purchased"}},limit:1){transactionHash}
    }`, {order: `${deploymentKey}:${orderId}`}, z.object({ChainEvent: z.array(z.object({transactionHash: z.string().regex(/^0x[0-9a-f]{64}$/)}))}));
    return result.ChainEvent[0]?.transactionHash ?? null;
  }

  async evidence(orderId: string, after: string, limit: number, requests = false): Promise<Record<string, unknown>[]> {
    const entity = requests ? "ChainEvidenceRequest" : "ChainEvidence";
    const fields = requests ? "id index revision participant commitment data assignment advisoryDate" : "id index revision submitter commitment data";
    const result = await this.query(`query($order:String!,$after:numeric!,$limit:Int!){
      rows:${entity}(where:{order:{_eq:$order},index:{_gt:$after}},order_by:{index:asc},limit:$limit){${fields}}
    }`, {
      order: `${deploymentKey}:${orderId}`,
      after,
      limit
    }, z.object({rows: z.array(z.record(z.string(), z.unknown()))}));
    return result.rows.map(row => ({...row, ...(typeof row.assignment === "string" ? {assignment: JSON.parse(row.assignment) as unknown} : {}), ...(typeof row.data === "string" ? {data: JSON.parse(row.data) as unknown} : {})}));
  }
}
