import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const action = process.argv[2];
const commands = {
  codegen: ["run", "--rm", "--no-deps", "indexer", "node", "node_modules/envio/bin.mjs", "codegen"],
  test: ["run", "--rm", "--no-deps", "indexer", "node", "node_modules/vitest/vitest.mjs", "run"],
  "test-live": ["run", "--rm", "--no-deps", "-e", "PAYUNLOCK_LIVE_INDEXER_TEST=1", "indexer", "node", "node_modules/vitest/vitest.mjs", "run", "test/live.test.ts"],
  typecheck: ["run", "--rm", "--no-deps", "indexer", "node", "node_modules/typescript/bin/tsc", "--noEmit"],
  start: ["up", "-d", "indexer"],
  dev: ["up", "indexer"],
};
if (!Object.hasOwn(commands, action)) throw new Error("Unsupported indexer command");
const result = spawnSync("docker", ["compose", "-f", "compose.indexer.yaml", ...commands[action]], {
  cwd: fileURLToPath(new URL("../../", import.meta.url)), stdio: "inherit", env: process.env,
});
process.exitCode = result.status ?? 1;
