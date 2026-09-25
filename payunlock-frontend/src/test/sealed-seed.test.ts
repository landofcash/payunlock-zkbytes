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
} from "@/exchange/sealed-seed";
import {
  sealSeed as sealLegacy,
  sealedSeedFragment as legacyFragment,
} from "@/exchange/sealed-seed-v2";

async function fixture() {
  const privateKey = randomBytes(32);
  const card = createReceiveCard(
    encodeBase64(await x25519PublicKeyFromPrivate(privateKey)),
  );
  const seed = encodeBase32(randomBytes(16));
  const envelope = await sealSeed(seed, card);
  return { privateKey, card, seed, envelope };
}

describe("direct encrypted seed links", () => {
  it("opens both 87-character and 131-character fragments without network requests", async () => {
    const network = vi.spyOn(globalThis, "fetch");
    const { privateKey, seed, envelope } = await fixture();
    try {
      for (const withKey of [false, true]) {
        const fragment = sealedSeedFragment(envelope, withKey);
        expect(fragment).toHaveLength(withKey ? 131 : 87);
        expect(fragment.split(".")).toHaveLength(withKey ? 2 : 1);
        expect(fragment).toMatch(
          withKey
            ? /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{87}$/
            : /^[A-Za-z0-9_-]{87}$/,
        );
        expect(parseSealedSeedFragment(fragment).recipientPublicKey).toBe(
          withKey ? envelope.recipientPublicKey : undefined,
        );
        expect(parseSealedSeedFragment(fragment).encryptedSeed).toBe(
          envelope.encryptedSeed,
        );
        const link = sealedSeedLink("https://zkbytes.com", envelope, withKey);
        expect(new URL(link).hash).toBe(`#${fragment}`);
        expect(await openSealedSeed(new URL(link).hash, privateKey)).toBe(seed);
        expect(fragment).not.toContain(seed);
      }
      expect(sealedSeedFragment(envelope, true).split(".")[1]).toBe(
        sealedSeedFragment(envelope),
      );
      expect(network).not.toHaveBeenCalled();
    } finally {
      privateKey.fill(0);
      network.mockRestore();
    }
  });

  it("retains cryptographic recipient binding when the visible key is omitted or replaced", async () => {
    const { privateKey, card, seed, envelope } = await fixture();
    const otherKey = randomBytes(32);
    try {
      const otherPublic = encodeBase64(
        await x25519PublicKeyFromPrivate(otherKey),
      );
      for (const withKey of [false, true]) {
        await expect(
          openSealedSeed(sealedSeedFragment(envelope, withKey), otherKey),
        ).rejects.toThrow();
        const changed = {
          ...envelope,
          encryptedSeed:
            envelope.encryptedSeed.slice(0, 20) +
            (envelope.encryptedSeed[20] === "A" ? "B" : "A") +
            envelope.encryptedSeed.slice(21),
        };
        await expect(
          openSealedSeed(sealedSeedFragment(changed, withKey), privateKey),
        ).rejects.toThrow();
      }
      const substituted = sealedSeedFragment(
        { ...envelope, recipientPublicKey: otherPublic },
        true,
      );
      await expect(openSealedSeed(substituted, privateKey)).rejects.toThrow();
      await expect(openSealedSeed(substituted, otherKey)).rejects.toThrow();
      expect((await sealSeed(seed, card)).encryptedSeed).not.toBe(
        envelope.encryptedSeed,
      );
    } finally {
      privateKey.fill(0);
      otherKey.fill(0);
    }
  });

  it("rejects extra separators, invalid lengths, noncanonical encoding and unsupported versions", async () => {
    const { privateKey, envelope } = await fixture();
    try {
      const short = sealedSeedFragment(envelope);
      const long = sealedSeedFragment(envelope, true);
      for (const fragment of [
        "",
        "#",
        short + "=",
        short.slice(1),
        short + ".",
        "." + short,
        long.replace(".", "-"),
        long.replace(".", ".."),
        short.slice(0, -1) + "B",
        "AAAA" + short.slice(4),
        "A".repeat(43) + "." + short,
        "a".repeat(10000),
        "https://zkbytes.com/open#" + short,
      ])
        expect(() => parseSealedSeedFragment(fragment)).toThrow();
      expect(() =>
        sealedSeedFragment({ encryptedSeed: short }, true),
      ).toThrow();
      expect(() => sealedSeedLink("http://zkbytes.com", envelope)).toThrow();
      expect(() =>
        sealedSeedLink("https://zkbytes.com/path", envelope),
      ).toThrow();
      expect(sealedSeedLink("http://localhost:5173", envelope)).toContain(
        "/open#",
      );
    } finally {
      privateKey.fill(0);
    }
  });

  it("still opens previously exported v2 seeds", async () => {
    const { privateKey, card, seed } = await fixture();
    try {
      const legacy = await sealLegacy(seed, card);
      expect(await openSealedSeed(legacyFragment(legacy), privateKey)).toBe(
        seed,
      );
    } finally {
      privateKey.fill(0);
    }
  });
});
