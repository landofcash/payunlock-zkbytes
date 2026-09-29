// Creates a separate zero-MON buyer for the V5 live USDC acceptance run.
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Wallet } from "ethers";

const path = resolve("../.env");
const env = await readFile(path, "utf8");
if (/^V5_ACCEPTANCE_BUYER_KEY=/m.test(env)) throw new Error("Acceptance buyer already configured");
const wallet = Wallet.createRandom();
await appendFile(path, `\nV5_ACCEPTANCE_BUYER_KEY=${wallet.privateKey}\n`);
console.log(JSON.stringify({ buyer: wallet.address, keyStoredInIgnoredEnv: true }));
