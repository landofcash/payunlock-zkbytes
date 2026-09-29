// Read-only verification of the V5 deployment and Circle USDC configuration.
// A funded authorization/purchase acceptance run is a separate explicit step.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Contract, Interface, JsonRpcProvider } from "ethers";

const USDC_TESTNET = "0x534b2f3A21130d7a60830c2Df862319e593943A3";
type Manifest = { chainId: number; escrow: string; router: string; usdc: string; deploymentBlock: number; admin: string };
let stage = "network";

async function main() {
  const url = process.env.MONAD_TESTNET_RPC_URL;
  if (!url) throw new Error("Configure the testnet RPC locally");
  const provider = new JsonRpcProvider(url, 10143, { staticNetwork: true });
  try {
    if ((await provider.getNetwork()).chainId !== 10143n) throw new Error("Wrong chain");
    const manifest = JSON.parse(await readFile(resolve("deployments/monad-testnet-payunlock-v5.json"), "utf8")) as Manifest;
    if (manifest.chainId !== 10143 || manifest.usdc.toLowerCase() !== USDC_TESTNET.toLowerCase()) throw new Error("Wrong V5 manifest");
    stage = "finalized-block";
    const finalized = await provider.getBlock("finalized");
    if (!finalized || finalized.number < manifest.deploymentBlock) throw new Error("Deployment is not finalized");
    const escrowAbi = JSON.parse(await readFile(resolve("abi/PayUnlock.json"), "utf8")) as { abi: Interface["fragments"] };
    const routerAbi = JSON.parse(await readFile(resolve("abi/PayUnlockAuthorizationRouter.json"), "utf8")) as { abi: Interface["fragments"] };
    const escrow = new Contract(manifest.escrow, escrowAbi.abi, provider);
    const router = new Contract(manifest.router, routerAbi.abi, provider);
    const token = new Contract(manifest.usdc, ["function name() view returns (string)", "function version() view returns (string)",
      "function authorizationState(address,bytes32) view returns (bool)"], provider);
    const at = { blockTag: finalized.number };
    const checks = ["escrowCode", "routerCode", "tokenCode", "owner", "configuredRouter", "allowed", "authorization", "arbitrationAsset", "routerEscrow", "tokenName", "tokenVersion", "serviceBps", "placementFee"];
    stage = "contract-calls";
    const results = await Promise.allSettled([
      provider.getCode(manifest.escrow, finalized.number), provider.getCode(manifest.router, finalized.number), provider.getCode(manifest.usdc, finalized.number),
      escrow.getFunction("owner").staticCall(at), escrow.getFunction("authorizationRouter").staticCall(at),
      escrow.getFunction("allowedAssets").staticCall(manifest.usdc, at), escrow.getFunction("receiveAuthorizationAssets").staticCall(manifest.usdc, at),
      escrow.getFunction("arbitrationFeeAsset").staticCall(at), router.getFunction("escrow").staticCall(at),
      token.getFunction("name").staticCall(at), token.getFunction("version").staticCall(at),
      escrow.getFunction("serviceFeeBps").staticCall(at), escrow.getFunction("offerPlacementFee").staticCall(at),
    ]);
    const failed = results.flatMap((result, index) => result.status === "rejected" ? [checks[index]] : []);
    if (failed.length) throw new Error(`V5 read-back failed: ${failed.join(", ")}`);
    const [escrowCode, routerCode, tokenCode, owner, configuredRouter, allowed, authorization, arbitrationAsset, routerEscrow,
      tokenName, tokenVersion, serviceBps, placementFee] = results.map(result => result.status === "fulfilled" ? result.value : undefined);
    if ([escrowCode, routerCode, tokenCode].some(code => code === "0x") || owner.toLowerCase() !== manifest.admin.toLowerCase() ||
        configuredRouter.toLowerCase() !== manifest.router.toLowerCase() || routerEscrow.toLowerCase() !== manifest.escrow.toLowerCase() ||
        !allowed || !authorization || arbitrationAsset.toLowerCase() !== manifest.usdc.toLowerCase() ||
        tokenName !== "USDC" || tokenVersion !== "2") throw new Error("V5 deployment configuration mismatch");
    console.log(JSON.stringify({ chainId: 10143, escrow: manifest.escrow, router: manifest.router, usdc: manifest.usdc,
      finalizedBlock: finalized.number, tokenName, tokenVersion, serviceFeeBps: String(serviceBps), offerPlacementFee: String(placementFee),
      fundedPurchaseTested: false, relayerTested: false }));
  } finally { provider.destroy(); }
}
main().catch(error => { console.error(JSON.stringify({ stage, errorType: error instanceof Error ? error.name : "unknown",
  check: error instanceof Error && error.message.startsWith("V5 read-back failed:") ? error.message : undefined })); process.exitCode = 1; });
