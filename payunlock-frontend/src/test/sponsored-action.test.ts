import { describe, expect, it } from "vitest";
import { validateTokenAuthorization } from "../wallet/typed-data";
import type { ReviewedTypedData } from "../wallet/types";

describe("sponsored action review", () => {
  const actor = `0x${"11".repeat(20)}`;
  const escrow = `0x${"22".repeat(20)}`;
  const router = `0x${"33".repeat(20)}`;
  function request(): ReviewedTypedData {
    const validBefore = String(Math.floor(Date.now() / 1000) + 3600);
    return { domain: { name: "PayUnlockActionRouter", version: "1", chainId: 10143, verifyingContract: router as `0x${string}` },
      primaryType: "PayUnlockAction", types: { PayUnlockAction: [
        { name: "actor", type: "address" }, { name: "escrow", type: "address" }, { name: "actionHash", type: "bytes32" },
        { name: "nonce", type: "bytes32" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" },
      ] }, message: { actor, escrow, actionHash: `0x${"11".repeat(32)}`, nonce: `0x${"22".repeat(32)}`, validAfter: "0", validBefore },
      review: { title: "Confirm receipt", asset: "token", amount: "0", rawValue: "0", decimals: 0, recipient: escrow,
        expiresAt: new Date(Number(validBefore) * 1000).toISOString() } };
  }
  it("accepts an exact actor and escrow with a bounded expiry", () => {
    expect(validateTokenAuthorization(request(), actor).message.actor).toBe(actor);
  });
  it("rejects actor, destination, action hash, and expiry substitutions", () => {
    const base = request();
    for (const changed of [
      { ...base, message: { ...base.message, actor: `0x${"44".repeat(20)}` } },
      { ...base, message: { ...base.message, escrow: `0x${"55".repeat(20)}` } },
      { ...base, message: { ...base.message, actionHash: "0x1234" } },
      { ...base, message: { ...base.message, validBefore: "1" } },
    ]) expect(() => validateTokenAuthorization(changed, actor)).toThrow();
  });
});
