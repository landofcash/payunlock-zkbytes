import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { runner } from "node-pg-migrate";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig();
const pool = new Pool({ connectionString: config.DATABASE_URL });
const schema = `test_foundation_${randomBytes(8).toString("hex")}`;
const options = { databaseUrl: config.DATABASE_URL, dir: fileURLToPath(new URL("../migrations/", import.meta.url)), schema, createSchema: true, migrationsTable: "pgmigrations", log: () => {}, logger: { info: () => {}, warn: () => {}, error: () => {} } };
try {
  const applied = await runner({ ...options, direction: "up" });
  assert.equal((await pool.query(`SELECT value FROM "${schema}".payunlock_metadata WHERE key = 'foundation_version'`)).rows[0].value, "1");
  assert.equal((await runner({ ...options, direction: "up" })).length, 0);
  await runner({ ...options, direction: "down", count: applied.length });
  assert.equal((await pool.query("SELECT to_regclass($1) AS name", [`${schema}.payunlock_metadata`])).rows[0].name, null);
  await runner({ ...options, direction: "up" });
  const app = buildApp({ ...config, LOG_LEVEL: "silent" });
  try { assert.equal((await app.inject("/ready")).statusCode, 200); } finally { await app.close(); }
  console.info("Database checks passed: up, idempotent up, down, reapply, API readiness.");
} finally {
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await pool.end();
}
