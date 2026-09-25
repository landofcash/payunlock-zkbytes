import { probeRpc } from "./rpc-probe.mjs";
try {
  const result = await probeRpc(process.env.MONAD_TESTNET_RPC_URL ?? "https://testnet-rpc.monad.xyz", { alchemyOnly: process.argv.includes("--alchemy") });
  console.log(JSON.stringify(result));
  console.log("Read-only check completed; no transaction submitted. Endpoint credentials omitted.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
