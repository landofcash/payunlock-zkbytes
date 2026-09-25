// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  encodeBase32,
  encodeBase64,
  randomBytes,
  x25519PublicKeyFromPrivate,
} from "@zkbytes/sdk";
import { createReceiveCard } from "@/exchange/receive-card";
import {
  sealSeed,
  openSealedSeed,
  sealedSeedLink,
  sealedSeedFragment,
  parseSealedSeedFragment,
  SEALED_SEED_FRAGMENT_LENGTH,
} from "@/exchange/sealed-seed-v2";

async function fixture() {
  const privateKey = randomBytes(32);
  const card = createReceiveCard(
    encodeBase64(await x25519PublicKeyFromPrivate(privateKey)),
  );
  const seed = encodeBase32(randomBytes(16));
  const envelope = await sealSeed(seed, card);
  return {
    privateKey,
    card,
    seed,
    envelope,
    fragment: sealedSeedFragment(envelope),
  };
}

describe("compact sealed seeds", () => {
  it("round trips only the seed in a fixed-size URL-safe link with exactly one hyphen", async () => {
    const network = vi.spyOn(globalThis, "fetch");
    const { privateKey, card, seed, envelope, fragment } = await fixture();
    try {
      expect(fragment).toHaveLength(295);
      expect(fragment).toHaveLength(SEALED_SEED_FRAGMENT_LENGTH);
      expect(fragment).toMatch(/^[a-z2-7]{52}-[a-z2-7]{242}$/);
      expect(fragment.split("-")).toHaveLength(2);
      expect(fragment).not.toContain(seed);
      expect(Object.keys(envelope)).toEqual([
        "recipientPublicKey",
        "encryptedSeed",
      ]);
      const link = sealedSeedLink("https://zkbytes.com", envelope);
      expect(new URL(link).search).toBe("");
      expect(new URL(link).hash).toBe(`#${fragment}`);
      expect(parseSealedSeedFragment(new URL(link).hash)).toEqual(envelope);
      expect(parseSealedSeedFragment(fragment).recipientPublicKey).toBe(
        card.publicKey,
      );
      expect(await openSealedSeed(fragment, privateKey)).toBe(seed);
      expect(network).not.toHaveBeenCalled();
    } finally {
      privateKey.fill(0);
      network.mockRestore();
    }
  });

  it("randomizes repeated seals and rejects wrong identities and modified crypto fields", async () => {
    const { privateKey, card, seed, envelope, fragment } = await fixture();
    try {
      const second = await sealSeed(seed, card);
      expect(second.encryptedSeed).not.toBe(envelope.encryptedSeed);
      expect(await openSealedSeed(sealedSeedFragment(second), privateKey)).toBe(
        seed,
      );
      await expect(openSealedSeed(fragment, randomBytes(32))).rejects.toThrow();
      // Alter base32 symbols inside context, HPKE envelope, GCM IV and ciphertext.
      for (const offset of [5, 40, 160, 190, 220]) {
        const changed =
          envelope.encryptedSeed.slice(0, offset) +
          (envelope.encryptedSeed[offset] === "a" ? "b" : "a") +
          envelope.encryptedSeed.slice(offset + 1);
        await expect(
          openSealedSeed(
            sealedSeedFragment({ ...envelope, encryptedSeed: changed }),
            privateKey,
          ),
        ).rejects.toThrow();
      }
      const otherKey = randomBytes(32);
      const otherPublicKey = encodeBase64(
        await x25519PublicKeyFromPrivate(otherKey),
      );
      await expect(
        openSealedSeed(
          sealedSeedFragment({
            ...envelope,
            recipientPublicKey: otherPublicKey,
          }),
          otherKey,
        ),
      ).rejects.toThrow();
      otherKey.fill(0);
    } finally {
      privateKey.fill(0);
    }
  });

  it("rejects malformed, oversized, ambiguous, noncanonical and unsupported encodings", async () => {
    const { privateKey, fragment, envelope } = await fixture();
    try {
      for (const input of [
        "",
        "#",
        fragment + "-",
        fragment.replace("-", "."),
        fragment.toUpperCase(),
        fragment.slice(1),
        fragment + "=",
        "a".repeat(10000),
        `https://zkbytes.com/open#${fragment}`,
        // Zero key, invalid padding bits, unsupported binary version.
        "a".repeat(52) + fragment.slice(52),
        fragment.slice(0, -1) + "b",
        fragment.slice(0, 53) + "b" + fragment.slice(54),
      ])
        expect(() => parseSealedSeedFragment(input)).toThrow();
      expect(() => sealedSeedLink("http://zkbytes.com", envelope)).toThrow();
      expect(() =>
        sealedSeedLink("https://zkbytes.com/path", envelope),
      ).toThrow();
      expect(sealedSeedLink("http://localhost:5173", envelope)).toContain(
        "/open#",
      );
      await expect(
        sealSeed("bad", createReceiveCard(envelope.recipientPublicKey)),
      ).rejects.toThrow();
    } finally {
      privateKey.fill(0);
    }
  });
});
