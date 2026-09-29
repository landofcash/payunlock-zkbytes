import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, copyFileSync, readFileSync, writeFileSync, createWriteStream } from "node:fs";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(new URL("../../payunlock-backend/package.json", import.meta.url));
const { Client } = require("pg");
const suffix = randomBytes(8).toString("hex"), schema = `phase4_reorg_${suffix}`, container = `payunlock-reorg-${suffix}`;
const env = { ...process.env, ENVIO_REORG_SCHEMA: schema };
const compose = ["compose", "-f", "compose.indexer.yaml", "-f", "compose.indexer-reorg.yaml"];
const output = `${root}/output/phase4-reorg`;
mkdirSync(`${output}/src/handlers`, { recursive: true });
mkdirSync(`${root}/output/phase-4`, { recursive: true });
copyFileSync(`${root}/payunlock-indexer/src/handlers/escrow.ts`, `${output}/src/handlers/escrow.ts`);
for (const file of ["schema.graphql", "tsconfig.json"]) copyFileSync(`${root}/payunlock-indexer/${file}`, `${output}/${file}`);
writeFileSync(`${output}/package.json`, '{"type":"module"}');
writeFileSync(`${output}/config.yaml`, readFileSync(`${root}/payunlock-indexer/config.yaml`, "utf8")
  .replace("name: payunlock", "name: payunlock-reorg")
  .replace("    start_block: 65572889", "    start_block: 65572889\n    rpc:\n      - url: http://host.docker.internal:18546\n        for: sync"));
function command(args) {
  const result = spawnSync("docker", [...compose, ...args], { cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 60000 });
  if (result.status !== 0) throw new Error("Reorg trial Docker command failed (see local trial setup)");
}
async function until(fn) {
  for (let i = 0; i < 45; i++) { if (await fn()) return; await delay(1000); }
  throw new Error("Reorg trial timed out");
}
const fixture = spawn(process.execPath, ["--import", "tsx", "scripts/indexer-reorg-fixture.ts"], { cwd: `${root}/payunlock-contract`, env, windowsHide: true, stdio: "ignore" });
const db = new Client({ host: "127.0.0.1", port: 5435, user: "envio", database: "envio", password: process.env.ENVIO_PG_PASSWORD });
const appDb = new Client({ connectionString: process.env.DATABASE_URL });
const log = createWriteStream(`${output}/runtime.log`);
let runtime;
try {
  await until(async () => { try { await fetch("http://127.0.0.1:18546", { method: "POST", body: JSON.stringify({ id: 1, method: "eth_chainId", params: [] }) }); return fixture.exitCode === null; } catch { return false; } });
  await db.connect(); await appDb.connect();
  // A marker in application metadata must survive Envio replay/rollback unchanged.
  await appDb.query("INSERT INTO payunlock_metadata(key,value) VALUES($1,$2)", [schema, suffix]);
  command(["run", "--rm", "--no-deps", "indexer", "node", "node_modules/envio/bin.mjs", "codegen"]);
  runtime = spawn("docker", [...compose, "run", "--rm", "--no-deps", "--name", container, "indexer", "node", "node_modules/envio/bin.mjs", "start"], { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  runtime.stdout.pipe(log, { end: false }); runtime.stderr.pipe(log, { end: false });
  const row = async () => { try { return (await db.query(`SELECT "arbitrator" FROM "${schema}"."ChainOrder"`)).rows[0]; } catch { return undefined; } };
  await until(async () => (await row())?.arbitrator === "0x3333333333333333333333333333333333333333");
  await fetch("http://127.0.0.1:18546/fork", { method: "POST" });
  await until(async () => (await row())?.arbitrator === "0x4444444444444444444444444444444444444444");
  assert.equal((await db.query(`SELECT count(*)::int AS count FROM "${schema}"."ChainOrder"`)).rows[0].count, 1);
  assert.equal((await db.query(`SELECT count(*)::int AS count FROM "${schema}"."ChainEvent"`)).rows[0].count, 3);
  assert.equal((await appDb.query("SELECT value FROM payunlock_metadata WHERE key=$1", [schema])).rows[0].value, suffix);
  const report = { checkedAt: new Date().toISOString(), runtime: "envio@3.12.1", source: "controlled RPC fork", rollbackTarget: 65572891, oldAuthorityRevoked: true, canonicalOrders: 1, canonicalEvents: 3, applicationMetadataPreserved: true };
  writeFileSync(`${root}/output/phase-4/reorg-check.json`, JSON.stringify(report, null, 2));
  console.info(JSON.stringify(report));
} finally {
  if (runtime) spawnSync("docker", ["stop", container], { stdio: "ignore", windowsHide: true, timeout: 15000 });
  fixture.kill(); log.end();
  // Only the schema uniquely created by this invocation is eligible for cleanup.
  if (/^phase4_reorg_[a-f0-9]{16}$/.test(schema)) {
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await appDb.query("DELETE FROM payunlock_metadata WHERE key=$1", [schema]).catch(() => {});
  }
  await db.end(); await appDb.end();
}
