import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(), broadcast: vi.fn(), receipt: vi.fn(), call: vi.fn(),
  close: vi.fn(), stop: undefined as (() => void) | undefined,
}));

vi.mock("../src/config.js", () => ({ loadConfig: () => ({
  RELAYER_PRIVATE_KEY: "test", RELAYER_DAILY_BUDGET_WEI: "1000000",
  RELAYER_MAX_FEE_PER_GAS_WEI: "100", CHAIN_ID: 10143,
}) }));
vi.mock("../src/services/chain-service.js", () => ({
  deployment: { router: "0xrouter", escrow: "0xescrow" }, escrowInterface: {},
}));
vi.mock("../src/services/relayer-service.js", () => ({ routerInterface: {} }));
vi.mock("pg", () => ({ Pool: class {
  query = mocks.query;
  connect = async () => ({ query: mocks.query, release: vi.fn() });
  end = mocks.close;
} }));
vi.mock("ethers", async importOriginal => ({
  ...await importOriginal<typeof import("ethers")>(),
  JsonRpcProvider: class {
    getBlock = async () => ({ number: 100, hash: "canonical" });
    getTransactionReceipt = mocks.receipt;
    broadcastTransaction = mocks.broadcast;
    call = mocks.call;
    destroy = vi.fn();
  },
  Wallet: class { address = "0xworker"; },
  Contract: class { getFunction = () => ({ staticCall: async () => 0n }); },
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("rebroadcasts an expired uncertain transaction and releases the queue after its finalized revert", async () => {
  vi.useFakeTimers();
  const expired = {
    id: "expired", kind: "purchase", actor: "0xbuyer", request_id: "request",
    transaction_hash: "original-hash", status: "uncertain", attempts: 1,
    expires_at: new Date(Date.now() - 60000), updated_at: new Date(Date.now() - 60000),
  };
  let nextSubmitted = false;
  const updates: unknown[][] = [];
  mocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
    if (sql.startsWith("SELECT * FROM relayer_jobs")) {
      return { rows: expired.status === "failed" ? [] : [expired] };
    }
    if (sql.startsWith("SELECT raw_transaction")) return { rows: [{ raw_transaction: "saved-raw" }] };
    if (sql.startsWith("SELECT count(*)")) return { rows: [{ count: expired.status === "failed" ? "0" : "1" }] };
    if (sql.startsWith("UPDATE relayer_jobs SET status='submitting'")) {
      nextSubmitted = true;
      return { rows: [{ id: "next", kind: "purchase", request_id: "next-request", calldata: "next-call" }] };
    }
    if (sql.startsWith("UPDATE relayer_jobs SET status=$2")) {
      updates.push(params!);
      if (params?.[0] === expired.id) expired.status = String(params[1]);
    }
    if (sql.startsWith("UPDATE relayer_jobs SET updated_at")) expired.updated_at = new Date();
    if (sql.startsWith("SELECT transaction_hash")) return { rows: [{ transaction_hash: null }] };
    return { rows: [] };
  });
  mocks.receipt.mockResolvedValue(null);
  mocks.broadcast.mockResolvedValue({});
  // Stop after proving the next job reached its normal submission path.
  mocks.call.mockImplementation(async () => {
    mocks.stop!();
    throw new Error("simulation failed");
  });
  const originalOnce = process.once.bind(process);
  vi.spyOn(process, "once").mockImplementation((event, listener) => {
    if (event === "SIGTERM") mocks.stop = listener as () => void;
    if (event === "SIGINT" || event === "SIGTERM") return process;
    return originalOnce(event, listener);
  });
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});

  await import("../src/worker.js");
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.broadcast).toHaveBeenCalledWith("saved-raw");
  expect(nextSubmitted).toBe(false);
  expect(expired.status).toBe("uncertain");

  mocks.receipt.mockResolvedValue({ blockNumber: 100, blockHash: "canonical", status: 0, gasUsed: 21n, gasPrice: 2n });
  await vi.advanceTimersByTimeAsync(5000);
  expect(updates).toContainEqual(["expired", "failed", "original-hash", "TRANSACTION_REVERTED"]);
  expect(nextSubmitted).toBe(true);
  expect(mocks.call).toHaveBeenCalledWith({ from: "0xworker", to: undefined, data: "next-call", value: 0n });
  await vi.advanceTimersByTimeAsync(5000);
});
