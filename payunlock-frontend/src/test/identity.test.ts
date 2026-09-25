// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Wallet } from "ethers";
import {
  createSeedSigningMessage,
  deriveItemKeys,
  normalizeAndVerifyMasterSignature,
  encodeBase64,
  clearItemKeys,
} from "@zkbytes/sdk";
import {
  deriveIdentity,
  identityMessage,
  validateLabel,
} from "@/exchange/identity";
import {
  createReceiveCard,
  parseReceiveCard,
  serializeReceiveCard,
} from "@/exchange/receive-card";
import type { LabWalletSession } from "@/wallet/types";
const wallet = new Wallet("0x" + "0".repeat(63) + "1");
const session: LabWalletSession = {
  kind: "fixture",
  walletName: "Fixture",
  transport: "fixture",
  address: wallet.address,
  signMessage: (message) => wallet.signMessage(message),
  disconnect: async () => {},
};
describe("receiving identity v1", () => {
  it("restores a stable public fixture and separates labels, accounts and item keys", async () => {
    const first = await deriveIdentity(session, "personal", () => true);
    const again = await deriveIdentity({ ...session }, "personal", () => true);
    expect(first.publicKey).toBe(again.publicKey);
    expect(first.publicKey).toMatchInlineSnapshot(
      `"E/frDPU+6KR8X6eFQ95jCOwDiIH1CCwoRmNqz+IxoyI="`,
    );
    const different = await deriveIdentity(session, "Personal", () => true);
    expect(different.publicKey).not.toBe(first.publicKey);
    const other = new Wallet("0x" + "0".repeat(63) + "2");
    const otherIdentity = await deriveIdentity(
      {
        ...session,
        address: other.address,
        signMessage: (message) => other.signMessage(message),
      },
      "personal",
      () => true,
    );
    expect(otherIdentity.publicKey).not.toBe(first.publicKey);
    const message = createSeedSigningMessage("a".repeat(52));
    const signature = normalizeAndVerifyMasterSignature(
      await wallet.signMessage(message),
      message,
      wallet.address,
    );
    const item = await deriveItemKeys(signature);
    expect(encodeBase64(item.encryptionPublicKey)).not.toBe(first.publicKey);
    clearItemKeys(item);
    signature.fill(0);
    [first, again, different, otherIdentity].forEach((identity) =>
      identity.privateKey.fill(0),
    );
  });
  it("pins the exact signing message and rejects ambiguous labels", () => {
    expect(identityMessage(wallet.address, "personal")).toMatchInlineSnapshot(`
      "zkbytes Message Lab receiving identity
      Profile: zkbytes-message-lab-receiving-v1
      Account: 0x7e5f4552091a69125d5dfcb7b8c2659029395bdf
      Label: "personal"
      Purpose: Restore my reusable receiving encryption key.
      Only sign this message in an application you trust. No transaction is requested."
    `);
    for (const label of [
      "",
      " personal",
      "personal ",
      "a\nb",
      "é",
      "a".repeat(65),
    ])
      expect(() => validateLabel(label)).toThrow();
  });
  it("rejects stale signing results and signatures from the wrong account", async () => {
    let active = true;
    await expect(
      deriveIdentity(
        {
          ...session,
          signMessage: async (message) => {
            const signature = await wallet.signMessage(message);
            active = false;
            return signature;
          },
        },
        "personal",
        () => active,
      ),
    ).rejects.toThrow();
    await expect(
      deriveIdentity(
        { ...session, address: "0x" + "2".repeat(40) },
        "personal",
        () => true,
      ),
    ).rejects.toThrow();
  });
  it("exchanges only a validated public key and rejects unsupported or ambiguous cards", async () => {
    const identity = await deriveIdentity(session, "personal", () => true);
    const card = createReceiveCard(identity.publicKey);
    const text = serializeReceiveCard(card);
    expect(parseReceiveCard(text)).toEqual(card);
    expect(text).not.toContain("personal");
    for (const invalid of [
      JSON.stringify({ ...card, label: "secret" }),
      JSON.stringify({ ...card, version: 2 }),
      JSON.stringify({ ...card, publicKey: "A".repeat(43) + "=" }),
      text.replace(".v1.", ".v2."),
      text + ".extra",
      " ".repeat(2049),
    ])
      expect(() => parseReceiveCard(invalid)).toThrow();
    identity.privateKey.fill(0);
  });
});
