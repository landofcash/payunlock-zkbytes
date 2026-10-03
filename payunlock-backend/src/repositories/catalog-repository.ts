import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { z } from "zod";
import { ApiError, json, productInput, type Order, type Receiving } from "../domain.js";
import { deploymentKey, deployment, escrowAddress, type CheckoutConfiguration } from "../services/chain-service.js";

import { imageDescriptor, type OfferImage } from "../services/offer-images.js";
import { offerPresentation } from "../services/offer-presentation.js";
type ProductInput = z.infer<typeof productInput>;
export interface ProductRow { id: string; seller: string; title: string; description: string; images?: OfferImage[]; restricted?: boolean; frontpage_position?: number | null; visibility: string; draft_terms: ProductInput["draftTerms"]; revision: number }
export interface Mapping { product_id: string; chain_id: number; contract: string; seller: string; product_key: string }
interface Intent { id: string; product_id: string; revision: number; buyer: string; request_id: string; expected_terms: string; buyer_receiving: Receiving; configuration: CheckoutConfiguration }
export class CatalogRepository {
  constructor(private db: Pool) {}
  async featured() {
    return (await this.db.query<ProductRow>(`SELECT * FROM catalog_products WHERE deployment_scope=$1
      AND visibility='public' AND NOT restricted AND frontpage_position IS NOT NULL ORDER BY frontpage_position`, [deploymentKey])).rows;
  }
  async restricted(after: string | undefined, limit: number) {
    return (await this.db.query<ProductRow>(`SELECT * FROM catalog_products WHERE deployment_scope=$1 AND restricted
      AND ($2::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM catalog_products WHERE id=$2::uuid AND deployment_scope=$1))
      ORDER BY created_at DESC,id DESC LIMIT $3`, [deploymentKey, after ?? null, limit])).rows;
  }
  async adminFeatured() {
    // One statement gives the list and version from the same database snapshot.
    const result = await this.db.query<{ version: string; items: ProductRow[] }>(`SELECT
      COALESCE((SELECT version::text FROM catalog_admin_state WHERE deployment_scope=$1),'0') AS version,
      COALESCE((SELECT jsonb_agg(p ORDER BY p.frontpage_position) FROM catalog_products p
        WHERE deployment_scope=$1 AND frontpage_position IS NOT NULL),'[]'::jsonb) AS items`, [deploymentKey]);
    return result.rows[0]!;
  }
  async adminProduct(id: string) {
    const result = await this.db.query<ProductRow & { version: string }>(`SELECT p.*,
      COALESCE((SELECT version::text FROM catalog_admin_state WHERE deployment_scope=$2),'0') AS version
      FROM catalog_products p WHERE p.id=$1 AND p.deployment_scope=$2`, [id, deploymentKey]);
    if (!result.rows[0]) throw new ApiError(404, "PRODUCT_NOT_FOUND");
    return result.rows[0];
  }
  private async lockAdminState(client: PoolClient) {
    await client.query("INSERT INTO catalog_admin_state(deployment_scope) VALUES($1) ON CONFLICT DO NOTHING", [deploymentKey]);
    return (await client.query<{ version: string }>("SELECT version::text FROM catalog_admin_state WHERE deployment_scope=$1 FOR UPDATE", [deploymentKey])).rows[0]!.version;
  }
  private async writePositions(client: PoolClient, ids: string[]) {
    await client.query("UPDATE catalog_products SET frontpage_position=NULL WHERE deployment_scope=$1 AND frontpage_position IS NOT NULL", [deploymentKey]);
    await client.query(`UPDATE catalog_products p SET frontpage_position=s.position::integer FROM unnest($2::uuid[]) WITH ORDINALITY AS s(id,position)
      WHERE p.deployment_scope=$1 AND p.id=s.id`, [deploymentKey, ids]);
  }
  async saveFeatured(ids: string[], expectedVersion: string) {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      if (await this.lockAdminState(client) !== expectedVersion) throw new ApiError(409, "FEATURED_LIST_CHANGED");
      const current = (await client.query<ProductRow>("SELECT * FROM catalog_products WHERE deployment_scope=$1 AND frontpage_position IS NOT NULL ORDER BY frontpage_position", [deploymentKey])).rows;
      if (new Set(ids).size !== ids.length || ids.some(id => !current.some(p => p.id === id))) throw new ApiError(400, "INVALID_FEATURED_LIST");
      await this.writePositions(client, ids);
      const version = (await client.query<{ version: string }>("UPDATE catalog_admin_state SET version=version+1 WHERE deployment_scope=$1 RETURNING version::text", [deploymentKey])).rows[0]!.version;
      await client.query("COMMIT");
      return { version, items: ids.map(id => current.find(p => p.id === id)!) };
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async moderate(id: string, input: { expectedVersion: string; featured?: boolean; restricted?: boolean }) {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      if (await this.lockAdminState(client) !== input.expectedVersion) throw new ApiError(409, "FEATURED_LIST_CHANGED");
      const product = (await client.query<ProductRow>("SELECT * FROM catalog_products WHERE id=$1 AND deployment_scope=$2 FOR UPDATE", [id, deploymentKey])).rows[0];
      if (!product) throw new ApiError(404, "PRODUCT_NOT_FOUND");
      const restricted = input.restricted ?? product.restricted ?? false;
      if (input.featured === true && (restricted || product.visibility !== "public")) throw new ApiError(409, "OFFER_NOT_ELIGIBLE_FOR_FEATURED");
      const ids = (await client.query<{ id: string }>("SELECT id FROM catalog_products WHERE deployment_scope=$1 AND frontpage_position IS NOT NULL ORDER BY frontpage_position", [deploymentKey])).rows.map(p => p.id);
      const selected = !restricted && (input.featured ?? ids.includes(id));
      const next = selected ? ids.includes(id) ? ids : [...ids, id] : ids.filter(value => value !== id);
      await client.query("UPDATE catalog_products SET restricted=$3 WHERE id=$1 AND deployment_scope=$2", [id, deploymentKey, restricted]);
      await this.writePositions(client, next);
      const version = (await client.query<{ version: string }>("UPDATE catalog_admin_state SET version=version+1 WHERE deployment_scope=$1 RETURNING version::text", [deploymentKey])).rows[0]!.version;
      await client.query("COMMIT");
      return { restricted, frontpagePosition: selected ? next.indexOf(id) + 1 : null, version };
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async publicOffer(seller: string, productKey: string) {
    const result = await this.db.query<{ id: string; title: string; description: string; images?: OfferImage[]; restricted?: boolean }>(`SELECT p.id,p.title,p.description,p.images,p.restricted FROM catalog_products p
      JOIN product_mappings m ON m.product_id=p.id
      WHERE m.chain_id=$1 AND m.contract=$2 AND m.seller=$3 AND m.product_key=$4
      AND p.deployment_scope=$5 AND p.visibility='public'`, [deployment.chainId, escrowAddress, seller, productKey, deploymentKey]);
    return result.rows[0] ? offerPresentation(result.rows[0]) : null;
  }
  async list(seller: string | undefined, after: string | undefined, limit: number, filter: "all" | "draft" | "published" = "all") {
    const result = await this.db.query<ProductRow>(`SELECT id,seller,title,description,images,visibility,draft_terms,revision,restricted,frontpage_position FROM catalog_products
      WHERE ($1::text IS NULL AND visibility='public' AND NOT restricted OR seller=$1) AND deployment_scope=$4
      AND ($2::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM catalog_products WHERE id=$2::uuid AND deployment_scope=$4))
      AND ($5::text='all' OR ($5='draft' AND visibility='draft') OR ($5='published' AND visibility IN ('public','hidden')))
      ORDER BY created_at DESC,id DESC LIMIT $3`, [seller ?? null, after ?? null, limit, deploymentKey, filter]);
    return result.rows;
  }
  async get(id: string, seller?: string): Promise<ProductRow> {
    const result = await this.db.query<ProductRow>("SELECT id,seller,title,description,images,visibility,draft_terms,revision,restricted,frontpage_position FROM catalog_products WHERE id=$1 AND deployment_scope=$2", [id, deploymentKey]);
    const row = result.rows[0];
    if (!row || (seller ? row.seller !== seller : row.visibility === "draft")) throw new ApiError(404, "PRODUCT_NOT_FOUND");
    return row;
  }
  async save(seller: string, input: ProductInput, id: string = randomUUID(), expectedRevision?: number) {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      await this.lockAdminState(client);
      const previous = expectedRevision === undefined ? undefined : (await client.query<ProductRow>("SELECT * FROM catalog_products WHERE id=$1 AND seller=$2 AND deployment_scope=$3 FOR UPDATE", [id, seller, deploymentKey])).rows[0];
      if (previous?.restricted) input = { ...input, title: previous.title, description: previous.description };
      let images: OfferImage[];
      if (previous?.restricted) {
        images = previous.images ?? [];
      } else if (input.images === undefined && expectedRevision !== undefined) {
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
      if (row.frontpage_position && row.visibility !== "public") {
        const ids = (await client.query<{ id: string }>("SELECT id FROM catalog_products WHERE deployment_scope=$1 AND frontpage_position IS NOT NULL AND id<>$2 ORDER BY frontpage_position", [deploymentKey, id])).rows.map(p => p.id);
        await this.writePositions(client, ids);
        row.frontpage_position = null;
        await client.query("UPDATE catalog_admin_state SET version=version+1 WHERE deployment_scope=$1", [deploymentKey]);
      }
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
    const result = await this.db.query<{ title: string; description: string; revision: number; images?: OfferImage[]; restricted?: boolean }>(`SELECT r.title,r.description,r.images,r.revision,p.restricted FROM purchased_offers o
      JOIN checkout_intents i ON i.id=o.intent_id JOIN offer_revisions r ON r.product_id=i.product_id AND r.revision=COALESCE(o.reviewed_revision,i.revision)
      JOIN catalog_products p ON p.id=i.product_id
      WHERE o.chain_id=$1 AND o.contract=$2 AND o.order_id=$3`, [deployment.chainId, escrowAddress, orderId]);
    return result.rows[0] ? { status: "recorded", ...offerPresentation(result.rows[0]), cryptographicallyBound: false } : { status: "unavailable", cryptographicallyBound: false };
  }
}
