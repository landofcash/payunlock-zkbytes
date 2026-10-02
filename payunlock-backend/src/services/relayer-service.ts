import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Interface, keccak256 } from "ethers";
import type { Pool } from "pg";
import { z } from "zod";
import { ApiError, address, nonzeroHash, orderId, parse, receiving, uint } from "../domain.js";
import { referenceSchema } from "./lifecycle-actions.js";
import { ChainService, deployment, escrowAddress } from "./chain-service.js";

const routerArtifact = JSON.parse(readFileSync(new URL("../../../payunlock-contract/abi/PayUnlockAuthorizationRouter.json", import.meta.url), "utf8"));
export const routerInterface = new Interface(routerArtifact.abi);
const u64 = uint.refine(value => BigInt(value) < 2n ** 64n);
const authorization = z.strictObject({ actor: address, validAfter: uint, validBefore: uint, salt: nonzeroHash, signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) });
const actionAuthorization = z.strictObject({ actor: address, nonce: nonzeroHash, validAfter: uint, validBefore: uint, signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) });
const reference = z.strictObject({ contentRef: referenceSchema, arbitratorEnvelope: z.string().regex(/^0x03[0-9a-fA-F]{128}$/) });
export const relayPacketSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("purchase"), chainId: z.literal(10143), escrow: address, router: address,
    intent: z.strictObject({ seller: address, productKey: nonzeroHash, requestId: nonzeroHash, expectedCheckoutHash: nonzeroHash, receiving }), authorization }),
  z.strictObject({ kind: z.literal("arbitration"), chainId: z.literal(10143), escrow: address, router: address,
    intent: z.strictObject({ orderId, arbitrator: address, keyVersion: u64, feeVersion: u64, fee: uint, evidence: reference }), authorization }),
  z.strictObject({ kind: z.literal("action"), chainId: z.literal(10143), escrow: address, router: address,
    actionData: z.string().regex(/^0x(?:[0-9a-fA-F]{2}){2,65536}$/), authorization: actionAuthorization }),
]);
export type RelayPacket = z.infer<typeof relayPacketSchema>;
type JobRow = { id: string; data_hash: string; status: string; transaction_hash: string | null; failure_reason: string | null; attempts: number; created_at: Date };

export class RelayerService {
  constructor(private db: Pool, private chain: ChainService) {}

  async enqueue(value: unknown) {
    const packet = parse(relayPacketSchema, value);
    if (packet.escrow !== escrowAddress || packet.router !== deployment.router.toLowerCase()) throw new ApiError(409, "WRONG_DEPLOYMENT");
    const now = Math.floor(Date.now() / 1000), after = BigInt(packet.authorization.validAfter), before = BigInt(packet.authorization.validBefore);
    if (after > BigInt(now) || before <= BigInt(now + 120) || before > BigInt(now + 86400)) throw new ApiError(400, "AUTHORIZATION_WINDOW_INVALID");
    const method = packet.kind === "purchase" ? "purchaseWithAuthorization" : packet.kind === "arbitration" ? "requestArbitrationWithAuthorization" : "executeAuthorized";
    const nonceMethod = packet.kind === "purchase" ? "purchaseNonce" : "arbitrationNonce";
    const args = packet.kind === "action" ? [{ actor: packet.authorization.actor, nonce: packet.authorization.nonce, validAfter: packet.authorization.validAfter, validBefore: packet.authorization.validBefore }, packet.actionData, packet.authorization.signature] : [packet.intent, packet.authorization];
    const data = routerInterface.encodeFunctionData(method, args), dataHash = keccak256(data).toLowerCase();
    const nonceCall = packet.kind === "action" ? undefined : routerInterface.encodeFunctionData(nonceMethod, args);
    let nonce: string;
    if (packet.kind === "action") nonce = packet.authorization.nonce;
    else {
      try {
        const raw = await this.chain.rpc<string>("eth_call", [{ to: packet.router, data: nonceCall }, "latest"]);
        nonce = String(routerInterface.decodeFunctionResult(nonceMethod, raw)[0]).toLowerCase();
      } catch { throw new ApiError(409, "RELAY_NONCE_UNAVAILABLE"); }
    }
    const existing = (await this.db.query<JobRow>(`SELECT id,data_hash,status,transaction_hash,failure_reason,attempts,created_at FROM relayer_jobs WHERE chain_id=$1 AND router=$2 AND actor=$3 AND nonce=$4`, [packet.chainId, packet.router, packet.authorization.actor, nonce])).rows[0];
    if (existing) {
      if (existing.data_hash !== dataHash) throw new ApiError(409, "RELAY_NONCE_CONFLICT");
      return { id: existing.id, status: existing.status, transactionHash: existing.transaction_hash, failureReason: existing.failure_reason, attempts: existing.attempts, createdAt: existing.created_at.toISOString(), nonce };
    }
    try {
      await this.chain.rpc<string>("eth_call", [{ from: packet.authorization.actor, to: packet.router, data }, "latest"]);
    } catch { throw new ApiError(409, "RELAY_SIMULATION_FAILED"); }
    const id = randomUUID();
    const requestId = packet.kind === "purchase" ? packet.intent.requestId : null;
    const orderId = packet.kind === "arbitration" ? packet.intent.orderId : null;
    const expires = new Date(Number(before) * 1000);
    const inserted = await this.db.query<JobRow>(`INSERT INTO relayer_jobs(id,chain_id,escrow,router,kind,actor,nonce,request_id,order_id,data_hash,calldata,expires_at,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'queued') ON CONFLICT(chain_id,router,actor,nonce) DO NOTHING
      RETURNING id,data_hash,status,transaction_hash,failure_reason,attempts,created_at`,
      [id, packet.chainId, packet.escrow, packet.router, packet.kind, packet.authorization.actor, nonce, requestId, orderId, dataHash, data, expires]);
    const job = inserted.rows[0] ?? (await this.db.query<JobRow>(`SELECT id,data_hash,status,transaction_hash,failure_reason,attempts,created_at FROM relayer_jobs WHERE chain_id=$1 AND router=$2 AND actor=$3 AND nonce=$4`, [packet.chainId, packet.router, packet.authorization.actor, nonce])).rows[0];
    if (!job || job.data_hash !== dataHash) throw new ApiError(409, "RELAY_NONCE_CONFLICT");
    return { id: job.id, status: job.status, transactionHash: job.transaction_hash, failureReason: job.failure_reason, attempts: job.attempts, createdAt: job.created_at.toISOString(), nonce };
  }

  async status(id: string) {
    const job = (await this.db.query<JobRow>(`SELECT id,data_hash,status,transaction_hash,failure_reason,attempts,created_at FROM relayer_jobs WHERE id=$1`, [id])).rows[0];
    if (!job) throw new ApiError(404, "RELAY_JOB_NOT_FOUND");
    return { id: job.id, status: job.status, transactionHash: job.transaction_hash, failureReason: job.failure_reason, attempts: job.attempts, createdAt: job.created_at.toISOString() };
  }
  async statusByNonce(actor: string, nonce: string) {
    const job = (await this.db.query<JobRow>(`SELECT id,data_hash,status,transaction_hash,failure_reason,attempts,created_at FROM relayer_jobs WHERE chain_id=$1 AND router=$2 AND actor=$3 AND nonce=$4`,
      [deployment.chainId, deployment.router.toLowerCase(), actor, nonce])).rows[0];
    if (!job) throw new ApiError(404, "RELAY_JOB_NOT_FOUND");
    return { id: job.id, status: job.status, transactionHash: job.transaction_hash, failureReason: job.failure_reason, attempts: job.attempts, createdAt: job.created_at.toISOString() };
  }
}
