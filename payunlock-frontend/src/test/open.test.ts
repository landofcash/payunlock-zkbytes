// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { Wallet } from "ethers";
import {
  ZkbytesClient,
  randomBytes,
  encodeBase64,
  x25519PublicKeyFromPrivate,
} from "@zkbytes/sdk";
import {
  createReceiveCard,
  serializeReceiveCard,
} from "@/exchange/receive-card";
import { prepareMessage } from "@/exchange/send";
import { sealedSeedLink } from "@/exchange/sealed-seed";
import { openMessage } from "@/exchange/open";

async function fixture() {
  const privateKey = randomBytes(32);
  const card = createReceiveCard(
    encodeBase64(await x25519PublicKeyFromPrivate(privateKey)),
  );
  const fetch = vi.fn<typeof globalThis.fetch>();
  const client = new ZkbytesClient({
    apiOrigin: "https://api.example.com",
    downloadOrigin: "https://files.example.com",
    fetch,
  });
  const sender = new Wallet("0x" + "0".repeat(63) + "2");
  const candidate = await prepareMessage(
    client,
    "Message for another recipient",
    serializeReceiveCard(card),
    "2035-01-01T00:00:00Z",
    sender,
    () => true,
  );
  fetch.mockImplementation(
    async () => new Response(JSON.stringify(candidate.item)),
  );
  return { client, fetch, privateKey, candidate };
}

describe("opening messages", () => {
  it.each([false, true])(
    "opens a sealed link with recipient key inclusion %s using only configured storage",
    async (includeKey) => {
      const { client, fetch, privateKey, candidate } = await fixture();
      try {
        const link = sealedSeedLink(
          "https://zkbytes.com",
          candidate.envelope,
          includeKey,
        );
        await expect(
          openMessage(link, privateKey, client, () => true),
        ).resolves.toEqual({
          plaintext: "Message for another recipient",
          expiresAt: candidate.item.expiresAt,
          expired: false,
        });
        expect(fetch).toHaveBeenCalledExactlyOnceWith(
          client.downloadUrl(candidate.item.seed),
          { method: "GET" },
        );
      } finally {
        privateKey.fill(0);
      }
    },
  );

  it("rejects wrong keys and bad links before requesting the object", async () => {
    const { client, fetch, privateKey, candidate } = await fixture();
    try {
      const link = sealedSeedLink("https://zkbytes.com", candidate.envelope);
      await expect(
        openMessage(link, randomBytes(32), client, () => true),
      ).rejects.toThrow();
      await expect(
        openMessage(
          "https://untrusted.invalid/message",
          privateKey,
          client,
          () => true,
        ),
      ).rejects.toThrow();
      await expect(
        openMessage("a".repeat(12001), privateKey, client, () => true),
      ).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      privateKey.fill(0);
    }
  });

  it("never returns plaintext from a tampered object or after session invalidation", async () => {
    const { client, fetch, privateKey, candidate } = await fixture();
    try {
      const link = sealedSeedLink("https://zkbytes.com", candidate.envelope);
      fetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ...candidate.item,
            encryptedPayload: candidate.item.encryptedPayload + "x",
          }),
        ),
      );
      await expect(
        openMessage(link, privateKey, client, () => true),
      ).rejects.toThrow();
      let current = true;
      fetch.mockImplementationOnce(async () => {
        current = false;
        return new Response(JSON.stringify(candidate.item));
      });
      await expect(
        openMessage(link, privateKey, client, () => current),
      ).rejects.toThrow("Operation cancelled");
    } finally {
      privateKey.fill(0);
    }
  });

  it("distinguishes authentic expired content from verification failure", async () => {
    const { client, privateKey, candidate } = await fixture();
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2036-01-01T00:00:00Z"));
    try {
      await expect(
        openMessage(
          sealedSeedLink("https://zkbytes.com", candidate.envelope),
          privateKey,
          client,
          () => true,
        ),
      ).resolves.toMatchObject({
        expired: true,
        plaintext: "Message for another recipient",
      });
    } finally {
      now.mockRestore();
      privateKey.fill(0);
    }
  });
});
