import { Interface, ZeroAddress } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { ChainService } from "../src/services/chain-service.js";
import { IndexerService } from "../src/services/indexer-service.js";
import { walletBalances } from "../src/services/wallet-balances.js";

const token = `0x${"11".repeat(20)}`, disabled = `0x${"22".repeat(20)}`, broken = `0x${"33".repeat(20)}`;
const erc20 = new Interface(["function symbol() view returns(string)", "function decimals() view returns(uint8)", "function balanceOf(address) view returns(uint256)"]);
function fixture() {
  const chain = new ChainService("https://unused.invalid"), indexer = new IndexerService();
  vi.spyOn(chain, "anchor").mockResolvedValue({ number: 123, timestamp: 1, hash: `0x${"44".repeat(32)}` });
  vi.spyOn(chain, "ensureCanonical").mockResolvedValue();
  vi.spyOn(chain, "call").mockImplementation(async (_, args) => [args[0] !== disabled && args[0] !== ZeroAddress] as never);
  vi.spyOn(indexer, "paymentAssets").mockResolvedValue([token, disabled, broken]);
  vi.spyOn(chain, "rpc").mockImplementation(async (method, params) => {
    expect(params[1]).toBe("0x7b");
    if (method === "eth_getBalance") return "0xde0b6b3a7640000" as never;
    const tx = params[0] as { to: string; data: string };
    if (tx.to === broken) throw new Error("token reverted");
    const name = erc20.parseTransaction(tx)!.name;
    return erc20.encodeFunctionResult(name, [name === "symbol" ? "TESTUSD" : name === "decimals" ? 6 : 1234567n]) as never;
  });
  return { chain, indexer };
}
describe("public wallet balances", () => {
  it("verifies enabled assets, preserves token decimals, isolates failures, and keeps MON for gas", async () => {
    const { chain, indexer } = fixture();
    const result = await walletBalances(chain, indexer, token);
    expect(result.items.map(r => r.address)).toEqual([ZeroAddress, token, broken]);
    expect(result.items[0]).toMatchObject({ allowed: false, decimals: 18, balance: "1000000000000000000" });
    expect(result.items[1]).toMatchObject({ symbol: "TESTUSD", decimals: 6, balance: "1234567" });
    expect(result.items[2]).toMatchObject({ decimals: null, balance: null });
    expect(result.incomplete).toBe(true);
    expect(chain.ensureCanonical).toHaveBeenCalled();
  });
  it("retains native balance during an indexer outage and makes incomplete discovery explicit", async () => {
    const { chain, indexer } = fixture();
    vi.mocked(indexer.paymentAssets).mockRejectedValue(new Error("offline"));
    const result = await walletBalances(chain, indexer, token);
    expect(result.items).toHaveLength(1); expect(result.items[0]!.balance).not.toBeNull();
    expect(result.discoveryAvailable).toBe(false); expect(result.incomplete).toBe(true);
  });
  it("paginates discovery even when every candidate is now disabled", async () => {
    const { chain, indexer } = fixture();
    const candidates = Array.from({ length: 21 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
    vi.mocked(indexer.paymentAssets).mockResolvedValue(candidates);
    vi.mocked(chain.call).mockResolvedValue([false] as never);
    const result = await walletBalances(chain, indexer, token, token);
    expect(result.items).toEqual([]); expect(result.nextCursor).toBe(candidates[19]);
    expect(indexer.paymentAssets).toHaveBeenCalledWith(token, 21);
  });
});
