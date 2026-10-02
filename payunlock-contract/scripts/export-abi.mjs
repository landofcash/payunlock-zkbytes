import { mkdir, readFile, writeFile } from "node:fs/promises";
const root = new URL("../", import.meta.url);
await mkdir(new URL("abi/", root), { recursive: true });
for (const [name, source] of [["PayUnlock", "PayUnlock.sol"], ["PayUnlockCodec", "PayUnlockCodec.sol"], ["PayUnlockAuthorizationRouter", "PayUnlockAuthorizationRouter.sol"]]) {
  const artifact = JSON.parse(await readFile(new URL(`artifacts/contracts/${source}/${name}.json`, root), "utf8"));
  await writeFile(new URL(`abi/${name}.json`, root), JSON.stringify({ contractName: artifact.contractName, abi: artifact.abi }, null, 2) + "\n");
}
console.log("Exported public ABI artifacts.");
