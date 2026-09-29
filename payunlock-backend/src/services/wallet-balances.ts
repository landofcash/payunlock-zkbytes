import { Interface, toQuantity, ZeroAddress } from "ethers";
import { ChainService, deployment } from "./chain-service.js";
import { IndexerService } from "./indexer-service.js";

const erc20 = new Interface(["function symbol() view returns(string)", "function decimals() view returns(uint8)", "function balanceOf(address) view returns(uint256)"]);
export type WalletAssetBalance = { address: string; symbol: string; decimals: number | null; balance: string | null; allowed: boolean | null };

export async function walletBalances(chain: ChainService, indexer: IndexerService, wallet: string, after?: string) {
  const block = await chain.anchor(), tag = toQuantity(block.number);
  let candidates: string[] = [], discoveryAvailable = true;
  try { candidates = await indexer.paymentAssets(after ?? ZeroAddress, 21); }
  catch { discoveryAvailable = false; }
  const nextCursor = candidates.length > 20 ? candidates[19]! : null;
  const addresses = [...(!after ? [ZeroAddress] : []), ...candidates.slice(0, 20).filter(a => a !== ZeroAddress)];
  const items: WalletAssetBalance[] = [];
  let incomplete = !discoveryAvailable;
  // Bound concurrent RPC calls; a broken token must not hide other balances.
  for (let offset = 0; offset < addresses.length; offset += 3) {
    const rows = await Promise.all(addresses.slice(offset, offset + 3).map(async address => {
      const native = address === ZeroAddress;
      let allowed: boolean | null = null;
      try { allowed = Boolean((await chain.call("allowedAssets", [address], block))[0]); }
      catch { incomplete = true; }
      if (!native && allowed !== true) return null;
      const row: WalletAssetBalance = { address, symbol: native ? "MON" : "Token", decimals: native ? 18 : null, balance: null, allowed };
      if (native) {
        try { row.balance = BigInt(await chain.rpc<string>("eth_getBalance", [wallet, tag])).toString(); }
        catch { incomplete = true; }
      } else {
        const read = async (name: string, args: unknown[] = []) => erc20.decodeFunctionResult(name, await chain.rpc<string>("eth_call", [{ to: address, data: erc20.encodeFunctionData(name, args) }, tag]))[0];
        const results = await Promise.allSettled([read("symbol"), read("decimals"), read("balanceOf", [wallet])]);
        if (results[0]!.status === "fulfilled") row.symbol = String(results[0]!.value).replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, 32) || "Token";
        if (results[1]!.status === "fulfilled") {
          const decimals = Number(results[1]!.value);
          if (Number.isInteger(decimals) && decimals >= 0 && decimals <= 80) row.decimals = decimals;
          else incomplete = true;
        }
        if (results[2]!.status === "fulfilled") row.balance = String(results[2]!.value);
        if (results.some(r => r.status === "rejected")) incomplete = true;
      }
      return row;
    }));
    items.push(...rows.filter((row): row is WalletAssetBalance => row !== null));
  }
  await chain.ensureCanonical(block);
  return { chainId: deployment.chainId, items, nextCursor, incomplete, discoveryAvailable, block };
}
