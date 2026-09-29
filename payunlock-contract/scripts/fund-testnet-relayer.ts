// Idempotently funds the project's separate development relayer on Monad Testnet.
import { JsonRpcProvider, Wallet, formatEther, parseEther } from "ethers";
import { waitFinalized } from "./finality.js";

const expectedDeployer = "0xe72f1873c09278018DbdB347E9E6500Eb3dFa896";
const expectedRelayer = "0x45bAd63aDAdA131Ff195ECcecBcD871f7CA27689";
const targetBalance = parseEther("0.5");

async function main() {
  if (!process.env.MONAD_TESTNET_DEPLOYER_KEY || !process.env.RELAYER_PRIVATE_KEY || !process.env.MONAD_TESTNET_RPC_URL) {
    throw new Error("Testnet deployer, relayer, and RPC configuration are required");
  }
  const provider = new JsonRpcProvider(process.env.MONAD_TESTNET_RPC_URL, 10143);
  try {
    if ((await provider.getNetwork()).chainId !== 10143n) throw new Error("Wrong chain");
    const deployer = new Wallet(process.env.MONAD_TESTNET_DEPLOYER_KEY, provider);
    const relayer = new Wallet(process.env.RELAYER_PRIVATE_KEY, provider);
    if (deployer.address.toLowerCase() !== expectedDeployer.toLowerCase() || relayer.address.toLowerCase() !== expectedRelayer.toLowerCase()) {
      throw new Error("Testnet funding account mismatch");
    }
    const existing = await provider.getBalance(relayer.address, "finalized");
    if (existing >= targetBalance) {
      console.log(JSON.stringify({ relayer: relayer.address, balance: formatEther(existing), funded: false }));
      return;
    }
    const amount = targetBalance - existing;
    if (await provider.getBalance(deployer.address) < amount + parseEther("0.1")) throw new Error("Insufficient deployer reserve");
    const transaction = await deployer.sendTransaction({ to: relayer.address, value: amount });
    const receipt = await waitFinalized(provider, transaction.hash);
    if (receipt.status !== 1) throw new Error("Funding transaction reverted");
    console.log(JSON.stringify({ relayer: relayer.address, funded: true, amount: formatEther(amount), transactionHash: transaction.hash,
      finalizedBlock: receipt.blockNumber, balance: formatEther(await provider.getBalance(relayer.address, "finalized")) }));
  } finally { provider.destroy(); }
}
main().catch(error => { console.error(JSON.stringify({ stage: "relayer-funding", errorType: error instanceof Error ? error.name : "unknown" })); process.exitCode = 1; });
