import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { HealthService } from "../src/services/health-service.js";

const env = { DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test", API_ORIGINS: "http://127.0.0.1:4320", MONAD_TESTNET_RPC_URL: "https://testnet-rpc.monad.xyz", CHAIN_ID: "10143", ALLOWED_CHAIN_IDS: "10143", ALLOWED_PAYMENT_ASSETS: "0x0000000000000000000000000000000000000000", ZKBYTES_SERVICE_URL: "https://storage.example.invalid", ZKBYTES_PROFILE: "zkbytes-wallet-eip191-sha256-secp256k1-hpke-v1", LOG_LEVEL: "silent" };

describe("foundation API", () => {
  it("serves liveness without migrating or connecting to the database and restricts CORS", async () => {
    const app = buildApp(loadConfig(env));
    try {
      const response = await app.inject({ url: "/health", headers: { origin: "http://127.0.0.1:4320" } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ok", service: "payunlock-api" });
      expect(response.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:4320");
      const foreign = await app.inject({ url: "/health", headers: { origin: "https://other.invalid" } });
      expect(foreign.headers["access-control-allow-origin"]).toBeUndefined();
      const unavailable = await app.inject("/ready");
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json()).toEqual({ status: "unavailable", database: "unavailable" });
    } finally { await app.close(); }
  });
  it("reports migrated database readiness without leaking database exceptions", async () => {
    expect(await new HealthService({ isReady: async () => true }).readiness()).toEqual({ status: "ready", database: "ready" });
    expect(await new HealthService({ isReady: async () => { throw new Error("secret-password"); } }).readiness()).toEqual({ status: "unavailable", database: "unavailable" });
  });
  it("rejects invalid deployment configuration without printing values", () => {
    expect(() => loadConfig({ ...env, DATABASE_URL: "secret-password", CHAIN_ID: "143" })).toThrow("Invalid configuration: DATABASE_URL, CHAIN_ID");
    expect(() => loadConfig({ ...env, ALLOWED_CHAIN_IDS: "10143,143" })).toThrow("ALLOWED_CHAIN_IDS");
    expect(() => loadConfig({ ...env, API_ORIGINS: "*" })).toThrow("API_ORIGINS");
  });
});
