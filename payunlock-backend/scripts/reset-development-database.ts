// Resets only the dedicated local PayUnlock development database for the V5 cutover.
// Run without --execute first to inspect the exact target and table count.
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
let stage = "configuration";

async function main() {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required");
  const url = new URL(value);
  if (!(["127.0.0.1", "localhost", "::1"].includes(url.hostname)) || url.port !== "5434" ||
      url.pathname !== "/payunlock" || url.search || url.hash) throw new Error("Only the dedicated local PayUnlock database at port 5434 may be reset");
  const manifest = JSON.parse(await readFile(new URL("../../payunlock-contract/deployments/monad-testnet-payunlock-v5.json", import.meta.url), "utf8")) as
    { chainId?: number; escrow?: string; router?: string };
  if (manifest.chainId !== 10143 || !/^0x[0-9a-fA-F]{40}$/.test(manifest.escrow ?? "") ||
      !/^0x[0-9a-fA-F]{40}$/.test(manifest.router ?? "")) throw new Error("Verified V5 deployment manifest required");
  stage = "database-connect";
  const pool = new Pool({ connectionString: value, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const client = await pool.connect();
    try {
      stage = "target-check";
      const target = (await client.query<{ name: string; port: number; schema: string }>(
        "SELECT current_database() AS name, inet_server_port() AS port, current_schema() AS schema")).rows[0];
      // Docker forwards host port 5434 to PostgreSQL's container port 5432.
      if (target?.name !== "payunlock" || target.port !== 5432 || target.schema !== "public") throw new Error("Connected database did not match the dedicated local target");
      stage = "schema-check";
      const otherSchemas = (await client.query<{ schema_name: string }>(
        "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('public','information_schema','pg_catalog') AND schema_name NOT LIKE 'pg_toast%'"))
        .rows.map(row => row.schema_name);
      if (otherSchemas.length) throw new Error("Unexpected application schemas are present; reset aborted");
      stage = "table-count";
      const tables = (await client.query<{ count: string }>("SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema='public'"))
        .rows[0]?.count ?? "0";
      console.info(JSON.stringify({ target: "127.0.0.1:5434/payunlock", publicTables: tables, v5Escrow: manifest.escrow,
        mode: process.argv.includes("--execute") ? "execute" : "dry-run" }));
      if (!process.argv.includes("--execute")) return;
      stage = "reset";
      await client.query("BEGIN");
      try {
        await client.query("DROP SCHEMA public CASCADE");
        await client.query("CREATE SCHEMA public");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      console.info("Dedicated PayUnlock development database reset. Apply forward migrations before starting V5 services.");
    } finally { client.release(); }
  } finally { await pool.end(); }
}
main().catch(error => { const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
  console.error(JSON.stringify({ stage, errorType: error instanceof Error ? error.name : "unknown", code })); process.exitCode = 1; });
