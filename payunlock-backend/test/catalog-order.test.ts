import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CatalogRepository } from "../src/repositories/catalog-repository.js";
import { deploymentKey } from "../src/services/chain-service.js";

describe.skipIf(process.env.PAYUNLOCK_DB_TEST !== "1")("newest-first catalog pagination with isolated PostgreSQL schema", () => {
  const schema = `catalog_order_test_${randomUUID().replaceAll("-", "")}`;
  const seller = `0x${"11".repeat(20)}`, otherSeller = `0x${"22".repeat(20)}`;
  const id = (value: number) => `00000000-0000-0000-0000-${String(value).padStart(12, "0")}`;
  let admin: Client, pool: Pool, catalog: CatalogRepository;
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Catalog ordering tests require a local PostgreSQL database.");
    admin = new Client({ connectionString: url.toString() });
    await admin.connect(); await admin.query(`CREATE SCHEMA ${schema}`); await admin.query(`SET search_path TO ${schema}`);
    const require = createRequire(import.meta.url);
    for (const file of ["202609250001_application.cjs", "202609260001_deployment_scope.cjs", "202609280001_offer_images.cjs", "202610030001_offer_moderation.cjs"]) {
      await require(`../migrations/${file}`).up({ sql: (sql: string) => admin.query(sql) });
    }
    url.searchParams.set("options", `-csearch_path=${schema}`);
    pool = new Pool({ connectionString: url.toString() }); catalog = new CatalogRepository(pool);
    await pool.query("INSERT INTO wallet_identities(address) VALUES($1),($2)", [seller, otherSeller]);
    for (const [number, created, visibility, owner, scope] of [
      [1, "2026-10-01", "public", seller, deploymentKey],
      [4, "2026-09-30", "public", seller, deploymentKey],
      [3, "2026-09-30", "public", seller, deploymentKey],
      [9, "2026-09-29", "public", seller, deploymentKey],
      [8, "2026-10-02", "hidden", seller, deploymentKey],
      [7, "2026-10-03", "draft", seller, deploymentKey],
      [6, "2026-10-04", "public", otherSeller, deploymentKey],
      [5, "2026-10-05", "public", seller, "other-deployment"],
    ] as const) {
      await pool.query("INSERT INTO catalog_products(id,seller,title,description,visibility,draft_terms,deployment_scope,created_at) VALUES($1,$2,$3,'Description',$4,'{}',$5,$6)", [id(number), owner, `Offer ${number}`, visibility, scope, created]);
    }
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) { if (!/^catalog_order_test_[a-f0-9]{32}$/.test(schema)) throw new Error("Unsafe test schema"); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });
  it("sorts public offers by creation time rather than UUID and breaks ties consistently", async () => {
    expect((await catalog.list(undefined, undefined, 20)).map(row => row.id)).toEqual([6, 1, 4, 3, 9].map(id));
  });
  it("paginates newest first without skipping or repeating equal timestamps", async () => {
    const first = await catalog.list(undefined, undefined, 3);
    const next = await catalog.list(undefined, first.at(-1)!.id, 3);
    expect([...first, ...next].map(row => row.id)).toEqual([6, 1, 4, 3, 9].map(id));
    expect(await catalog.list(undefined, next.at(-1)!.id, 3)).toEqual([]);
  });
  it("applies the same order to seller offers while preserving ownership and visibility filters", async () => {
    expect((await catalog.list(seller, undefined, 20)).map(row => row.id)).toEqual([7, 8, 1, 4, 3, 9].map(id));
    expect((await catalog.list(seller, undefined, 20, "draft")).map(row => row.id)).toEqual([7].map(id));
    const first = await catalog.list(seller, undefined, 2, "published");
    const next = await catalog.list(seller, first.at(-1)!.id, 20, "published");
    expect([...first, ...next].map(row => row.id)).toEqual([8, 1, 4, 3, 9].map(id));
  });
  it("atomically reorders and removes featured offers and rejects concurrent stale saves", async () => {
    let version = (await catalog.adminFeatured()).version;
    version = (await catalog.moderate(id(1), { expectedVersion: version, featured: true })).version;
    version = (await catalog.moderate(id(4), { expectedVersion: version, featured: true })).version;
    expect((await catalog.featured()).map(p => p.id)).toEqual([id(1), id(4)]);
    await expect(catalog.saveFeatured([id(1), id(1)], version)).rejects.toMatchObject({ code: "INVALID_FEATURED_LIST" });
    await expect(catalog.saveFeatured([id(3)], version)).rejects.toMatchObject({ code: "INVALID_FEATURED_LIST" });
    await expect(catalog.moderate(id(8), { expectedVersion: version, featured: true })).rejects.toMatchObject({ code: "OFFER_NOT_ELIGIBLE_FOR_FEATURED" });
    await expect(catalog.moderate(id(5), { expectedVersion: version, featured: true })).rejects.toMatchObject({ code: "PRODUCT_NOT_FOUND" });
    const results = await Promise.allSettled([catalog.saveFeatured([id(4), id(1)], version), catalog.saveFeatured([id(1)], version)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    const state = await catalog.adminFeatured();
    const result = await catalog.saveFeatured([id(1)], state.version);
    expect((await catalog.featured()).map(p => p.frontpage_position)).toEqual([1]);
    expect((await catalog.adminProduct(id(4))).frontpage_position).toBeNull();
    const restricted = await catalog.moderate(id(1), { expectedVersion: result.version, restricted: true });
    expect(await catalog.featured()).toEqual([]);
    expect((await catalog.list(undefined, undefined, 20)).map(p => p.id)).not.toContain(id(1));
    expect((await catalog.list(seller, undefined, 20)).map(p => p.id)).toContain(id(1));
    await expect(catalog.moderate(id(1), { expectedVersion: restricted.version, featured: true })).rejects.toMatchObject({ code: "OFFER_NOT_ELIGIBLE_FOR_FEATURED" });
    await catalog.moderate(id(1), { expectedVersion: restricted.version, restricted: false });
    expect(await catalog.featured()).toEqual([]);
  });
  it("removes an offer made private by its seller and renumbers the remaining selection", async () => {
    let version = (await catalog.adminFeatured()).version;
    version = (await catalog.moderate(id(1), { expectedVersion: version, featured: true })).version;
    await catalog.moderate(id(4), { expectedVersion: version, featured: true });
    const saved = await catalog.save(seller, { title: "Offer 1", description: "Description", visibility: "hidden", draftTerms: { token: `0x${"00".repeat(20)}`, price: "1", eventEnd: null, reviewWindow: null, commitmentWindow: 600 } }, id(1), 1);
    expect(saved.frontpage_position).toBeNull();
    expect((await catalog.featured()).map(p => [p.id, p.frontpage_position])).toEqual([[id(4), 1]]);
  });
  it("paginates original restricted metadata across all visibilities within the active deployment", async () => {
    await pool.query("UPDATE catalog_products SET restricted=true WHERE id=ANY($1::uuid[])", [[3, 5, 7, 8, 9].map(id)]);
    const first = await catalog.restricted(undefined, 2), next = await catalog.restricted(first.at(-1)!.id, 2);
    expect([...first, ...next].map(p => p.id)).toEqual([7, 8, 3, 9].map(id));
    expect(first[0]).toMatchObject({ title: "Offer 7", description: "Description", visibility: "draft", restricted: true });
    expect(first[1]).toMatchObject({ visibility: "hidden" });
    expect(await catalog.restricted(next.at(-1)!.id, 2)).toEqual([]);
    await expect(catalog.adminProduct(id(5))).rejects.toMatchObject({ code: "PRODUCT_NOT_FOUND" });
  });
});
