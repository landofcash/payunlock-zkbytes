// One-time local setup. The key is written only to the ignored workspace .env.
import { appendFile, readFile } from "node:fs/promises";
import { Wallet } from "ethers";

const path = new URL("../../.env", import.meta.url);
const source = await readFile(path, "utf8");
if (/^RELAYER_PRIVATE_KEY=/m.test(source)) throw new Error("Relayer key already configured; refusing to replace it");
const wallet = Wallet.createRandom();
await appendFile(path, `${source.endsWith("\n") ? "" : "\n"}RELAYER_PRIVATE_KEY=${wallet.privateKey}\n`, { mode: 0o600 });
console.info(`Separate relayer account created: ${wallet.address}. Fund it only after the V5 deployment is verified.`);
