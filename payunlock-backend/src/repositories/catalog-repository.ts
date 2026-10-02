import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { z } from "zod";
import { ApiError, json, productInput, type Order, type Receiving } from "../domain.js";
import { deploymentKey, deployment, escrowAddress, type CheckoutConfiguration } from "../services/chain-service.js";

import { imageDescriptor, type OfferImage } from "../services/offer-images.js";
type ProductInput = z.infer<typeof productInput>;
export interface ProductRow { id: string; seller: string; title: string; description: string; images?: OfferImage[]; visibility: string; draft_terms: ProductInput["draftTerms"]; revision: number }
export interface Mapping { product_id: string; chain_id: number; contract: string; seller: string; product_key: string }
interface Intent { id: string; product_id: string; revision: number; buyer: string; request_id: string; expected_terms: string; buyer_receiving: Receiving; configuration: CheckoutConfiguration }
export class CatalogRepository {
  constructor(private db: Pool) {}
  async publicOffer(seller: string, productKey: string) {
    const result = await this.db.query<{ id: string; title: string; description: string }>(`SELECT p.id,p.title,p.description,p.images FROM catalog_products p
      JOIN product_mappings m ON m.product_id=p.id
      WHERE m.chain_id=$1 AND m.contract=$2 AND m.seller=$3 AND m.product_key=$4
      AND p.deployment_scope=$5 AND p.visibility='public'`, [deployment.chainId, escrowAddress, seller, productKey, deploymentKey]);
    return result.rows[0] ?? null;
  }
  async list(seller: string | undefined, after: string | undefined, limit: number, filter: "all" | "draft" | "published" = "all") {
    const result = await this.db.query<ProductRow>(`SELECT id,seller,title,description,images,visibility,draft_terms,revision FROM catalog_products
      WHERE ($1::text IS NULL AND visibility='public' OR seller=$1) AND deployment_scope=$4
      AND ($2::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM catalog_products WHERE id=$2::uuid AND deployment_scope=$4))
      AND ($5::text='all' OR ($5='draft' AND visibility='draft') OR ($5='published' AND visibility IN ('public','hidden')))
      ORDER BY created_at DESC,id DESC LIMIT $3`, [seller ?? null, after ?? null, limit, deploymentKey, filter]);
    return result.rows;
  }
  async get(id: string, seller?: string): Promise<ProductRow> {
    const result = await this.db.query<ProductRow>("SELECT id,seller,title,description,images,visibility,draft_terms,revision FROM catalog_products WHERE id=$1 AND deployment_scope=$2", [id, deploymentKey]);
    const row = result.rows[0];
    if (!row || (seller ? row.seller !== seller : row.visibility === "draft")) throw new ApiError(404, "PRODUCT_NOT_FOUND");
    return row;
  }
  async save(seller: string, input: ProductInput, id: string = randomUUID(), expectedRevision?: number) {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      let images: OfferImage[];
      if (input.images === undefined && expectedRevision !== undefined) {
        images = (await client.query("SELECT images FROM catalog_products WHERE id=$1 AND seller=$2", [id, seller])).rows[0]?.images ?? [];
      } else {
        const ids = (input.images ?? []).map(i => i.id);
        const assets = (await client.query<{ id: string; width: number; height: number }>("SELECT id,width,height FROM offer_images WHERE owner=$1 AND id=ANY($2::uuid[])", [seller, ids])).rows;
        if (assets.length !== ids.length) throw new ApiError(400, "IMAGE_NOT_OWNED");
        images = ids.map(id => { const asset = assets.find(a => a.id === id)!; return imageDescriptor(id, asset.width, asset.height); });
      }
      const result = expectedRevision === undefined
        ? await client.query<ProductRow>(`INSERT INTO catalog_products(id,seller,title,description,visibility,draft_terms,deployment_scope,images) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [id, seller, input.title, input.description, input.visibility, json(input.draftTerms), deploymentKey, json(images)])
        : await client.query<ProductRow>(`UPDATE catalog_products SET title=$3,description=$4,visibility=$5,draft_terms=$6,images=$9,revision=revision+1,updated_at=now()
          WHERE id=$1 AND seller=$2 AND revision=$7 AND deployment_scope=$8 RETURNING *`, [id, seller, input.title, input.description, input.visibility, json(input.draftTerms), expectedRevision, deploymentKey, json(images)]);
      const row = result.rows[0];
      if (!row) throw new ApiError(409, "PRODUCT_CHANGED_OR_NOT_OWNED");
      await client.query("INSERT INTO offer_revisions(product_id,revision,title,description,images) VALUES($1,$2,$3,$4,$5)", [id, row.revision, row.title, row.description, json(images)]);
      await client.query("COMMIT");
      return row;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async map(id: string, seller: string, productKey: string) {
    await this.get(id, seller);
    try { await this.db.query("INSERT INTO product_mappings(product_id,chain_id,contract,seller,product_key) VALUES($1,$2,$3,$4,$5) ON CONFLICT(product_id) DO NOTHING", [id, deployment.chainId, escrowAddress, seller, productKey]); }
    catch (error) { if ((error as { code?: string }).code === "23505") throw new ApiError(409, "PRODUCT_ALREADY_MAPPED"); throw error; }
    const mapping = await this.mapping(id);
    if (mapping.product_key !== productKey || mapping.seller !== seller) throw new ApiError(409, "MAPPING_IMMUTABLE");
    return mapping;
  }
  async mapping(id: string) {
    const result = await this.db.query<Mapping>("SELECT * FROM product_mappings WHERE product_id=$1 AND chain_id=$2 AND contract=$3", [id, deployment.chainId, escrowAddress]);
    if (!result.rows[0]) throw new ApiError(409, "PRODUCT_NOT_REGISTERED");
    return result.rows[0];
  }
  async mappings(ids: string[]) {
    return (await this.db.query<Mapping>("SELECT * FROM product_mappings WHERE product_id=ANY($1::uuid[]) AND chain_id=$2 AND contract=$3", [ids, deployment.chainId, escrowAddress])).rows;
  }
  async intent(buyer: string, requestId: string) {
    return (await this.db.query<Intent>("SELECT * FROM checkout_intents WHERE chain_id=$1 AND contract=$2 AND buyer=$3 AND request_id=$4", [deployment.chainId, escrowAddress, buyer, requestId])).rows[0];
  }
  async prepare(product: ProductRow, buyer: string, requestId: string, receiving: Receiving, configuration: CheckoutConfiguration) {
    await this.db.query(`INSERT INTO checkout_intents(id,product_id,revision,chain_id,contract,buyer,request_id,expected_terms,buyer_receiving,configuration)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(chain_id,contract,buyer,request_id) DO NOTHING`,
    [randomUUID(), product.id, product.revision, deployment.chainId, escrowAddress, buyer, requestId, configuration.expectedTerms, json(receiving), json(configuration)]);
    const intent = (await this.intent(buyer, requestId))!;
    if (intent.product_id !== product.id || intent.buyer_receiving.nonce !== receiving.nonce || intent.buyer_receiving.publicKey !== receiving.publicKey) throw new ApiError(409, "REQUEST_ID_ALREADY_USED");
    await this.recordReview(intent.id, intent.revision, intent.configuration);
    return intent;
  }
  async associate(orderId: string, order: Order, purchaseCommitment: () => Promise<string | null>) {
    const intent = await this.intent(order.buyer, order.requestId);
    if (!intent || intent.buyer_receiving.nonce !== order.buyerReceiving.nonce || intent.buyer_receiving.publicKey !== order.buyerReceiving.publicKey) return;
    const expected = await purchaseCommitment();
    if (!expected) return;
    const review = await this.review(intent.id, expected);
    const revision = review?.revision ?? (intent.expected_terms === expected ? intent.revision : undefined);
    if (!revision) return;
    await this.db.query("INSERT INTO purchased_offers(chain_id,contract,order_id,intent_id,reviewed_revision) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [deployment.chainId, escrowAddress, orderId, intent.id, revision]);
  }
  async review(intentId: string, expected: string) {
    return (await this.db.query<{ revision: number; configuration: CheckoutConfiguration }>("SELECT revision,configuration FROM checkout_reviews WHERE intent_id=$1 AND expected_terms=$2", [intentId, expected])).rows[0];
  }
  async recordReview(intentId: string, revision: number, configuration: CheckoutConfiguration) {
    await this.db.query("INSERT INTO checkout_reviews(intent_id,expected_terms,revision,configuration) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [intentId, configuration.expectedTerms, revision, json(configuration)]);
    return (await this.review(intentId, configuration.expectedTerms))!;
  }
  async offer(orderId: string) {
    const result = await this.db.query<{ title: string; description: string; revision: number }>(`SELECT r.title,r.description,r.images,r.revision FROM purchased_offers o
      JOIN checkout_intents i ON i.id=o.intent_id JOIN offer_revisions r ON r.product_id=i.product_id AND r.revision=COALESCE(o.reviewed_revision,i.revision)
      WHERE o.chain_id=$1 AND o.contract=$2 AND o.order_id=$3`, [deployment.chainId, escrowAddress, orderId]);
    return result.rows[0] ? { status: "recorded", ...result.rows[0], cryptographicallyBound: false } : { status: "unavailable", cryptographicallyBound: false };
  }
}
