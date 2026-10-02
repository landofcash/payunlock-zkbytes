import { readFile } from "node:fs/promises";
import { network } from "hardhat";
import PayUnlock from "../ignition/modules/PayUnlock.js";

// Local EVM only: configure V5 with a mock receive-authorization token.
const connection = await network.create("hardhatMainnet");
try {
  const [admin] = await connection.ethers.getSigners();
  if (!admin) throw new Error("Missing local deployer");
  const token = await connection.ethers.deployContract("MockReceiveAuthorizationToken", [admin.address]);
  await token.waitForDeployment();
  const parameters = JSON.parse(await readFile(new URL("../ignition/parameters/payunlock-local.json", import.meta.url), "utf8"));
  parameters.PayUnlockV5.admin = admin.address;
  parameters.PayUnlockV5.usdc = await token.getAddress();
  const result = await connection.ignition.deploy(PayUnlock, { parameters, displayUi: false });
  console.log(JSON.stringify({ escrow: await result.escrow.getAddress(), router: await result.router.getAddress(), usdc: await token.getAddress() }));
} finally { await connection.close(); }
