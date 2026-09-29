import { spawnSync } from "node:child_process";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const result = spawnSync(process.execPath, ["../node_modules/vitest/vitest.mjs", "run"], {
  stdio: "inherit", env: { ...process.env, PAYUNLOCK_DB_TEST: "1" },
});
process.exitCode = result.status ?? 1;
