import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { network, artifacts } from "hardhat";
import { formatEther, keccak256 } from "ethers";
import PayUnlock from "../ignition/modules/PayUnlock.js";
import { waitFinalized } from "./finality.js";

const USDC_TESTNET = "0x534b2f3A21130d7a60830c2Df862319e593943A3";

let stage = "configuration";
async function main() {
  const mode = process.argv[2] ?? "preflight";
  if (!["preflight", "deploy"].includes(mode)) throw new Error("Invalid mode");
  if (!process.env.MONAD_TESTNET_DEPLOYER_KEY || !process.env.MONAD_TESTNET_RPC_URL) throw new Error("Configure the test deployer and RPC locally");
  const host = new URL(process.env.MONAD_TESTNET_RPC_URL).hostname;
  if (!host.endsWith(".alchemy.com")) throw new Error("Live trial requires Alchemy");
  const connection = await network.create("monadTestnet");
  try {
    const { ethers } = connection;
    const chain = await ethers.provider.getNetwork();
    if (chain.chainId !== 10143n) throw new Error("Wrong chain");
    const [admin] = await ethers.getSigners();
    if (!admin) throw new Error("Missing signer");
    stage = "preflight";
    const balance = await ethers.provider.getBalance(admin.address);
    const finalized = await ethers.provider.getBlock("finalized");
    if (!finalized?.hash) throw new Error("No finalized block");
    console.log(JSON.stringify({ stage, chainId: 10143, deployer: admin.address, testMon: formatEther(balance), finalizedBlock: finalized.number }));
    if (mode === "preflight") return;
    if (balance === 0n) throw new Error("Fund test deployer first");
    if (await ethers.provider.getCode(USDC_TESTNET) === "0x") throw new Error("Circle USDC code missing");
    const parameters = { PayUnlockV5: { admin: admin.address, defaultReviewWindow: 86400, minResponseWindow: 60, minCommitmentWindow: 60, maxCommitmentWindow: 86400, usdc: USDC_TESTNET } };
    stage = "ignition-deploy";
    const deploymentId = "monad-testnet-payunlock-v5";
    const result = await connection.ignition.deploy(PayUnlock, { deploymentId, parameters, displayUi: false });
    stage = "verify-deployment";
    const addresses = { escrow: await result.escrow.getAddress(), codec: await result.codec.getAddress(), arbitration: await result.arbitration.getAddress(), transfers: await result.transfers.getAddress(), router: await result.router.getAddress() };
    const journal = await readFile(resolve(`ignition/deployments/${deploymentId}/journal.jsonl`), "utf8");
    const hashes = [...new Set(journal.split(/\r?\n/).filter(Boolean).flatMap(line => {
      const entry = JSON.parse(line) as { type: string; hash?: string };
      return entry.type === "TRANSACTION_CONFIRM" && entry.hash ? [entry.hash] : [];
    }))];
    if (!hashes.length) throw new Error("No deployment receipts in journal");
    const receipts = [];
    for (const hash of hashes) {
      const receipt = await waitFinalized(ethers.provider, hash);
      if (receipt.status !== 1) throw new Error("Deployment transaction reverted");
      receipts.push({ hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash });
    }
    const bytecodeHashes: Record<string, string> = {};
    for (const [name, address] of Object.entries(addresses)) {
      const code = await ethers.provider.getCode(address);
      if (code === "0x") throw new Error("Contract code missing");
      const artifactsByName = { escrow: "PayUnlock", codec: "PayUnlockCodec", arbitration: "PayUnlockArbitration", transfers: "PayUnlockTransfers", router: "PayUnlockAuthorizationRouter" } as const;
      const compiled = await artifacts.readArtifact(artifactsByName[name as keyof typeof artifactsByName]);
      let expected = compiled.deployedBytecode.slice(2).toLowerCase(), actual = code.slice(2).toLowerCase();
      for (const libraries of Object.values(compiled.deployedLinkReferences)) for (const [library, positions] of Object.entries(libraries)) {
        const libraryAddresses = { PayUnlockCodec: addresses.codec, PayUnlockArbitration: addresses.arbitration, PayUnlockTransfers: addresses.transfers } as const;
        const linked = libraryAddresses[library as keyof typeof libraryAddresses];
        if (!linked) throw new Error("Unknown linked library");
        for (const p of positions) expected = expected.slice(0, p.start * 2) + linked.slice(2).toLowerCase() + expected.slice((p.start + p.length) * 2);
      }
      for (const positions of Object.values(compiled.immutableReferences ?? {})) for (const p of positions) {
        const mask = "0".repeat(p.length * 2);
        expected = expected.slice(0, p.start * 2) + mask + expected.slice((p.start + p.length) * 2);
        actual = actual.slice(0, p.start * 2) + mask + actual.slice((p.start + p.length) * 2);
      }
      if (["codec", "arbitration", "transfers"].includes(name) && expected.startsWith("73")) expected = "73" + address.slice(2).toLowerCase() + expected.slice(42);
      if (actual !== expected) throw new Error("Runtime bytecode differs from compiled artifact");
      bytecodeHashes[name] = keccak256(code);
    }
    if (await result.escrow.getFunction("batchLimit")() !== 30n || !await result.escrow.getFunction("allowedStorageServices")(1) || await result.escrow.getFunction("owner")() !== admin.address || await result.escrow.getFunction("defaultReviewWindow")() !== 86400n || await result.escrow.getFunction("responseWindow")() !== 259200n || await result.escrow.getFunction("minResponseWindow")() !== 60n || await result.escrow.getFunction("minCommitmentWindow")() !== 60n || await result.escrow.getFunction("maxCommitmentWindow")() !== 86400n || !await result.escrow.getFunction("allowedAssets")(USDC_TESTNET) || !await result.escrow.getFunction("receiveAuthorizationAssets")(USDC_TESTNET) || await result.escrow.getFunction("authorizationRouter")() !== addresses.router || await result.escrow.getFunction("arbitrationFeeAsset")() !== USDC_TESTNET) throw new Error("Deployment configuration mismatch");
    const artifact = await artifacts.readArtifact("PayUnlock");
    const info = { schemaVersion: 2, chainId: 10143, deploymentId, ...addresses, usdc: USDC_TESTNET, deploymentBlock: Math.min(...receipts.map(r => r.blockNumber)), admin: admin.address, abiVersion: "payunlock-v5", abiHash: keccak256(new TextEncoder().encode(JSON.stringify(artifact.abi))), parameters: parameters.PayUnlockV5, bytecodeHashes, finalizedReceipts: receipts, checkedAt: new Date().toISOString() };
    await mkdir(resolve("deployments"), { recursive: true });
    await writeFile(resolve("deployments/monad-testnet-payunlock-v5.json"), JSON.stringify(info, null, 2) + "\n");
    console.log(JSON.stringify({ stage: "deployment-verified", ...addresses, deploymentBlock: info.deploymentBlock, transactions: receipts.length }));
  } finally { await connection.close(); }
}
main().catch(error => { console.error(JSON.stringify({ stage, errorType: error instanceof Error ? error.name : "unknown" })); process.exitCode = 1; });
