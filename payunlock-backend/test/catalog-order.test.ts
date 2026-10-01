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
    for (const file of ["202609250001_application.cjs", "202609260001_deployment_scope.cjs", "202609280001_offer_images.cjs"]) {
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
});
