import { Contract, JsonRpcProvider, Wallet, keccak256, zeroPadValue } from "ethers";
import { Pool } from "pg";
import { loadConfig } from "./config.js";
import { deployment, escrowInterface } from "./services/chain-service.js";
import { routerInterface } from "./services/relayer-service.js";
import { classifyActionLogs, classifyActionReceipt } from "./services/relayer-recovery.js";

type Job = { id: string; kind: "purchase" | "arbitration" | "action"; actor: string; nonce: string; request_id: string | null; order_id: string | null;
  router: string; calldata: string | null; transaction_hash: string | null; attempts: number; updated_at: Date; expires_at: Date; status: string };

async function main() {
  const config = loadConfig();
  if (!config.RELAYER_PRIVATE_KEY || !config.RELAYER_DAILY_BUDGET_WEI || !config.RELAYER_MAX_FEE_PER_GAS_WEI) {
    console.info("Relayer is disabled. Configure the V5 deployment and funded worker limits to enable it.");
    return;
  }
  const dailyBudget = BigInt(config.RELAYER_DAILY_BUDGET_WEI);
  const maxFeeCap = BigInt(config.RELAYER_MAX_FEE_PER_GAS_WEI);
  const provider = new JsonRpcProvider(config.MONAD_TESTNET_RPC_URL, config.CHAIN_ID);
  const wallet = new Wallet(config.RELAYER_PRIVATE_KEY, provider);
  const pool = new Pool({ connectionString: config.DATABASE_URL, max: 2, connectionTimeoutMillis: 5000, query_timeout: 10000 });
  const escrow = new Contract(deployment.escrow, escrowInterface, provider);
  const lockClient = await pool.connect();
  const lockName = `payunlock-relayer:${config.CHAIN_ID}:${deployment.router.toLowerCase()}`;
  let waitingForLock = false;
  while (true) {
    const lock = (await lockClient.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS acquired", [lockName])).rows[0];
    if (lock?.acquired) break;
    if (!waitingForLock) console.info("Waiting for the previous relayer worker to release this funded account queue.");
    waitingForLock = true;
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  let closing = false;
  async function stop() {
    if (closing) return;
    closing = true;
    try { await lockClient.query("SELECT pg_advisory_unlock(hashtext($1)::bigint)", [lockName]); }
    finally { lockClient.release(); await pool.end(); provider.destroy(); }
  }
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });

  async function externalOutcome(job: Job): Promise<"finalized" | "failed" | null> {
    if (job.kind === "purchase" && job.request_id) {
      const id = await escrow.getFunction("orderForRequest").staticCall(job.actor, job.request_id, { blockTag: "finalized" });
      return BigInt(id) !== 0n ? "finalized" : null;
    }
    if (job.kind === "arbitration" && job.order_id) {
      try {
        const assignment = await escrow.getFunction("getAssignment").staticCall(job.order_id, { blockTag: "finalized" });
        return String(assignment.requester).toLowerCase() === job.actor ? "finalized" : null;
      } catch { return null; }
    }
    if (job.kind === "action") {
      if (job.transaction_hash) {
        const receipt = await provider.getTransactionReceipt(job.transaction_hash);
        const finalized = receipt && await provider.getBlock("finalized");
        if (receipt && finalized && receipt.blockNumber <= finalized.number && receipt.status === 1) {
          const block = await provider.getBlock(receipt.blockNumber);
          if (block?.hash === receipt.blockHash) {
            const outcome = classifyActionReceipt(routerInterface, job.calldata, job.actor, job.nonce, job.router, receipt.logs);
            if (outcome) return outcome;
          }
        }
      }
      const used = await new Contract(job.router, routerInterface, provider).getFunction("usedActionNonces").staticCall(job.actor, job.nonce, { blockTag: "finalized" });
      if (!used) return null;
      const finalized = await provider.getBlock("finalized");
      if (!finalized) return null;
      const executedTopic = routerInterface.getEvent("ActionExecuted")!.topicHash;
      const canceledTopic = routerInterface.getEvent("ActionCanceled")!.topicHash;
      const topics = [[executedTopic, canceledTopic], zeroPadValue(job.actor, 32), job.nonce];
      for (let end = finalized.number; end >= deployment.deploymentBlock; end -= 5000) {
        const start = Math.max(deployment.deploymentBlock, end - 4999);
        const outcome = classifyActionLogs(routerInterface, job.calldata, await provider.getLogs({ address: job.router, fromBlock: start, toBlock: end, topics }));
        if (outcome) return outcome;
      }
      return null;
    }
    return null;
  }
  async function finish(id: string, status: "finalized" | "failed", hash: string | null, gasCost?: bigint, failureReason?: string) {
    await pool.query("UPDATE relayer_jobs SET status=$2,transaction_hash=COALESCE($3,transaction_hash),calldata=NULL,failure_reason=$4,updated_at=now() WHERE id=$1", [id, status, hash, failureReason ?? null]);
    if (hash) await pool.query("UPDATE relayer_attempts SET status=$3,gas_cost_wei=$4,raw_transaction=NULL WHERE job_id=$1 AND transaction_hash=$2", [id, hash, status === "finalized" ? "finalized" : "reverted", gasCost?.toString() ?? null]);
  }
  async function reconcileCosts() {
    // Finalized effects can be discovered before their receipts. Replace the
    // conservative gas reservation once the canonical receipt is available.
    const rows = (await pool.query<{ job_id: string; transaction_hash: string }>(`SELECT a.job_id,a.transaction_hash FROM relayer_attempts a
      JOIN relayer_jobs j ON j.id=a.job_id WHERE j.status='finalized' AND a.gas_cost_wei IS NULL AND a.transaction_hash IS NOT NULL LIMIT 20`)).rows;
    const finalized = rows.length ? await provider.getBlock("finalized") : null;
    for (const row of rows) {
      const receipt = await provider.getTransactionReceipt(row.transaction_hash);
      if (!receipt || !finalized || receipt.blockNumber > finalized.number) continue;
      const block = await provider.getBlock(receipt.blockNumber);
      if (block?.hash !== receipt.blockHash) continue;
      await pool.query("UPDATE relayer_attempts SET gas_cost_wei=$3 WHERE job_id=$1 AND transaction_hash=$2 AND gas_cost_wei IS NULL",
        [row.job_id, row.transaction_hash, (receipt.gasUsed * receipt.gasPrice).toString()]);
    }
  }
  async function reconcile() {
    const rows = (await pool.query<Job>("SELECT * FROM relayer_jobs WHERE status IN ('submitted','uncertain','submitting') ORDER BY updated_at LIMIT 20")).rows;
    const finalized = await provider.getBlock("finalized");
    if (!finalized) return;
    for (const job of rows) {
      const outcome = await externalOutcome(job);
      if (outcome && !job.transaction_hash) {
        await finish(job.id, outcome, null, undefined,
          outcome === "failed" ? "AUTHORIZATION_CANCELED" : undefined);
        continue;
      }
      if (!job.transaction_hash) {
        // Broadcasting begins only after the raw transaction/hash are committed.
        // No hash therefore proves this attempt never reached the network.
        if (Date.now() - job.updated_at.getTime() > 120000) await pool.query("UPDATE relayer_jobs SET status='queued',updated_at=now() WHERE id=$1", [job.id]);
        continue;
      }
      const receipt = await provider.getTransactionReceipt(job.transaction_hash);
      if (receipt && receipt.blockNumber <= finalized.number) {
        const block = await provider.getBlock(receipt.blockNumber);
        if (block?.hash !== receipt.blockHash) continue;
        // Another relayer's result does not consume our wallet nonce. Wait for
        // our receipt, but preserve that result even if our transaction reverted.
        if (outcome) {
          await finish(job.id, outcome, job.transaction_hash, receipt.gasUsed * receipt.gasPrice,
            outcome === "failed" ? "AUTHORIZATION_CANCELED" : undefined);
          continue;
        }
        // A successful outer transaction is not proof of the intended escrow effect.
        // Confirm the actor-bound result on the finalized chain before closing the job.
        if (receipt.status === 1) {
          if (await externalOutcome(job) === "finalized") await finish(job.id, "finalized", job.transaction_hash, receipt.gasUsed * receipt.gasPrice);
          else await pool.query("UPDATE relayer_jobs SET status='uncertain',updated_at=now() WHERE id=$1", [job.id]);
        } else {
          await finish(job.id, "failed", job.transaction_hash, receipt.gasUsed * receipt.gasPrice, "TRANSACTION_REVERTED");
        }
      } else if (!receipt && Date.now() - job.updated_at.getTime() > 30000) {
        // Expiry prevents the authorized operation, but does not consume the
        // worker wallet's nonce. Keep rebroadcasting until a canonical receipt
        // resolves the transaction, including a revert after authorization expiry.
        const attempt = (await pool.query<{ raw_transaction: string | null }>("SELECT raw_transaction FROM relayer_attempts WHERE job_id=$1 AND transaction_hash=$2", [job.id, job.transaction_hash])).rows[0];
        if (attempt?.raw_transaction) {
          try { await provider.broadcastTransaction(attempt.raw_transaction); } catch { /* Already known or temporarily unavailable; reconcile by hash. */ }
          await pool.query("UPDATE relayer_jobs SET updated_at=now() WHERE id=$1", [job.id]);
        }
      }
    }
  }
  async function submitOne() {
    const pending = (await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM relayer_jobs WHERE status IN ('submitting','submitted','uncertain')")).rows[0];
    if (BigInt(pending?.count ?? "0") !== 0n) return;
    const job = (await pool.query<Job>(`UPDATE relayer_jobs SET status='submitting',attempts=attempts+1,updated_at=now()
      WHERE id=(SELECT id FROM relayer_jobs WHERE status='queued' AND expires_at>now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`)).rows[0];
    if (!job) return;
    const outcome = await externalOutcome(job);
    if (outcome) { await finish(job.id, outcome, null); return; }
    if (!job.calldata) { await finish(job.id, "failed", null, undefined, "MISSING_CALLDATA"); return; }
    try {
      const transaction = { from: wallet.address, to: job.router, data: job.calldata, value: 0n };
      await provider.call(transaction);
      const gasLimit = await provider.estimateGas(transaction) * 12n / 10n;
      if (gasLimit > BigInt(config.RELAYER_MAX_GAS_LIMIT)) throw new Error("GAS_LIMIT");
      const feeData = await provider.getFeeData();
      const maxFee = feeData.maxFeePerGas ?? feeData.gasPrice;
      if (!maxFee || maxFee > maxFeeCap) throw new Error("GAS_PRICE");
      const spent = (await pool.query<{ amount: string }>("SELECT COALESCE(sum(COALESCE(gas_cost_wei,reserved_cost_wei)),0)::text AS amount FROM relayer_attempts WHERE created_at>=date_trunc('day',now())")).rows[0];
      if (BigInt(spent?.amount ?? "0") + gasLimit * maxFee > dailyBudget) throw new Error("DAILY_BUDGET");
      if (await provider.getBalance(wallet.address) < gasLimit * maxFee) throw new Error("RELAYER_BALANCE");
      const nonce = await provider.getTransactionCount(wallet.address, "pending");
      const raw = await wallet.signTransaction({ to: job.router, data: job.calldata, value: 0n, gasLimit, maxFeePerGas: maxFee,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas && feeData.maxPriorityFeePerGas < maxFee ? feeData.maxPriorityFeePerGas : maxFee,
        nonce, chainId: config.CHAIN_ID, type: 2 });
      const hash = keccak256(raw);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("INSERT INTO relayer_attempts(job_id,attempt,transaction_hash,reserved_cost_wei,status,raw_transaction) VALUES($1,$2,$3,$4,'prepared',$5)",
          [job.id, job.attempts, hash, (gasLimit * maxFee).toString(), raw]);
        await client.query("UPDATE relayer_jobs SET status='submitted',transaction_hash=$2,updated_at=now() WHERE id=$1", [job.id, hash]);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
      await provider.broadcastTransaction(raw);
      await pool.query("UPDATE relayer_attempts SET status='submitted' WHERE job_id=$1 AND transaction_hash=$2", [job.id, hash]);
    } catch (error) {
      // Once the raw transaction is durable, the next cycle reuses those exact bytes.
      const saved = (await pool.query<{ transaction_hash: string | null }>("SELECT transaction_hash FROM relayer_jobs WHERE id=$1", [job.id])).rows[0];
      if (!saved?.transaction_hash) {
        const code = error instanceof Error ? error.message : "";
        const reason = ["GAS_LIMIT", "GAS_PRICE", "DAILY_BUDGET", "RELAYER_BALANCE"].includes(code) ? code : "SIMULATION_OR_SUBMISSION_FAILED";
        await finish(job.id, "failed", null, undefined, reason);
        console.warn("Relayer job failed before broadcast.", { id: job.id, reason });
      }
    }
  }
  async function tick() {
    await pool.query("UPDATE relayer_jobs SET status='failed',calldata=NULL,failure_reason='AUTHORIZATION_EXPIRED',updated_at=now() WHERE status='queued' AND expires_at<=now()");
    await reconcile();
    await reconcileCosts();
    await submitOne();
  }
  console.info(`Relayer worker started for chain ${config.CHAIN_ID} at ${wallet.address}.`);
  while (!closing) {
    try { await tick(); } catch (error) {
      const details = error as { code?: unknown; info?: { error?: { code?: unknown } } };
      console.error("Relayer worker cycle failed; retrying.", { code: details?.code, rpcCode: details?.info?.error?.code });
    }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}
main().catch(() => { console.error("Relayer worker could not start."); process.exitCode = 1; });
