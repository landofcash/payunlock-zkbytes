import {createHash, randomBytes, randomUUID} from "node:crypto";
import {getAddress, verifyMessage} from "ethers";
import type {Pool} from "pg";
import {ApiError} from "../domain.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export class AuthService {
  constructor(private db: Pool, private origins: string[], private isEOA: (wallet: string) => Promise<boolean>) {
  }

  origin(value?: string): string {
    if (!value || !this.origins.includes(value)) throw new ApiError(403, "ORIGIN_NOT_ALLOWED");
    return value;
  }

  async rateLimit(ip: string, operation: string, maximum: number) {
    const key = digest(`${operation}:${ip}:${Math.floor(Date.now() / 60000)}`);
    const result = await this.db.query<{ count: number }>(`INSERT INTO api_rate_buckets(key,count,expires_at) VALUES($1,1,now()+interval '2 minutes')
      ON CONFLICT(key) DO UPDATE SET count=api_rate_buckets.count+1 RETURNING count`, [key]);
    if (result.rows[0]!.count > maximum) throw new ApiError(429, "RATE_LIMITED");
  }

  async challenge(wallet: string, origin: string) {
    this.origin(origin);
    const id = randomUUID(), nonce = randomBytes(16).toString("hex");
    const issued = new Date(), expires = new Date(issued.getTime() + 300000);
    const message = `${new URL(origin).host} wants you to sign in with your Ethereum account:\n${getAddress(wallet)}\n\nSign in to PayUnlock. This does not authorize a purchase or payment.\n\nURI: ${origin}\nVersion: 1\nChain ID: 10143\nNonce: ${nonce}\nIssued At: ${issued.toISOString()}\nExpiration Time: ${expires.toISOString()}\nRequest ID: ${id}`;
    await this.db.query("DELETE FROM auth_challenges WHERE expires_at < now() - interval '1 day'");
    await this.db.query("DELETE FROM auth_sessions WHERE expires_at < now()");
    await this.db.query("DELETE FROM api_rate_buckets WHERE expires_at < now()");
    await this.db.query("INSERT INTO auth_challenges(id,address,origin,message,expires_at) VALUES($1,$2,$3,$4,$5)", [id, wallet, origin, message, expires]);
    return {id, message, expiresAt: expires.toISOString(), accountType: "eoa"};
  }

  async verify(id: string, signature: string, origin: string) {
    this.origin(origin);
    const result = await this.db.query<{
      address: string;
      message: string
    }>("SELECT address,message FROM auth_challenges WHERE id=$1 AND origin=$2 AND consumed_at IS NULL AND expires_at>now()", [id, origin]);
    const challenge = result.rows[0];
    if (!challenge) throw new ApiError(401, "INVALID_CHALLENGE");
    let signer: string;
    try {
      signer = verifyMessage(challenge.message, signature).toLowerCase();
    } catch {
      throw new ApiError(401, "INVALID_SIGNATURE");
    }
    if (signer !== challenge.address) throw new ApiError(401, "INVALID_SIGNATURE");
    if (!await this.isEOA(signer)) throw new ApiError(400, "UNSUPPORTED_ACCOUNT_TYPE");
    const token = randomBytes(32).toString("hex"), expires = new Date(Date.now() + 12 * 3600000);
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const consumed = await client.query("UPDATE auth_challenges SET consumed_at=now() WHERE id=$1 AND origin=$2 AND consumed_at IS NULL AND expires_at>now() RETURNING id", [id, origin]);
      if (!consumed.rowCount) throw new ApiError(401, "INVALID_CHALLENGE");
      await client.query("INSERT INTO wallet_identities(address) VALUES($1) ON CONFLICT DO NOTHING", [signer]);
      await client.query("INSERT INTO auth_sessions(token_hash,address,origin,expires_at) VALUES($1,$2,$3,$4)", [digest(token), signer, origin, expires]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    return {token, address: signer, expiresAt: expires.toISOString()};
  }

  async authenticate(authorization: string | undefined, origin: string | undefined) {
    this.origin(origin);
    if (!authorization || !/^Bearer [a-f0-9]{64}$/.test(authorization)) throw new ApiError(401, "UNAUTHENTICATED");
    const result = await this.db.query<{
      address: string
    }>("SELECT address FROM auth_sessions WHERE token_hash=$1 AND origin=$2 AND expires_at>now()", [digest(authorization.slice(7)), origin]);
    if (!result.rows[0]) throw new ApiError(401, "UNAUTHENTICATED");
    return result.rows[0].address;
  }

  async logout(authorization: string) {
    await this.db.query("DELETE FROM auth_sessions WHERE token_hash=$1", [digest(authorization.slice(7))]);
  }
}
