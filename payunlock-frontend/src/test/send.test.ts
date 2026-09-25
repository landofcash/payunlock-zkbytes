// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { Wallet } from "ethers";
import {
  ZkbytesClient,
  decryptStorageItem,
  type StorageItem,
} from "@zkbytes/sdk";
import {
  prepareMessage,
  recoverCandidate,
  uploadCandidate,
} from "@/exchange/send";
import { deriveIdentity } from "@/exchange/identity";
import {
  createReceiveCard,
  serializeReceiveCard,
} from "@/exchange/receive-card";
import { openSealedSeed, sealedSeedFragment } from "@/exchange/sealed-seed";

async function fixture() {
  const sender = new Wallet("0x" + "0".repeat(63) + "1");
  const recipient = new Wallet("0x" + "0".repeat(63) + "2");
  const identity = await deriveIdentity(
    {
      kind: "fixture",
      walletName: "recipient",
      transport: "fixture",
      address: recipient.address,
      signMessage: (message) => recipient.signMessage(message),
      disconnect: async () => {},
    },
    "personal",
    () => true,
  );
  const fetch = vi.fn<typeof globalThis.fetch>();
  const client = new ZkbytesClient({
    apiOrigin: "https://api.example.com",
    downloadOrigin: "https://files.example.com",
    fetch,
  });
  const signer = {
    address: sender.address,
    signMessage: vi.fn((message: string) => sender.signMessage(message)),
  };
  const candidate = await prepareMessage(
    client,
    "Confidential message 123",
    serializeReceiveCard(createReceiveCard(identity.publicKey)),
    "2035-01-01T00:00:00Z",
    signer,
    () => true,
  );
  return { client, fetch, candidate, identity, signer };
}
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
describe("message sending", () => {
  it("requires separate upload and sends encrypted data only; another wallet decrypts both layers", async () => {
    const { client, fetch, candidate, identity, signer } = await fixture();
    expect(fetch).not.toHaveBeenCalled();
    expect(signer.signMessage).toHaveBeenCalledOnce();
    expect(candidate.item.managers).toEqual([candidate.item.creator]);
    expect(candidate.item.encryptedKeys).toHaveLength(2);
    expect(Object.keys(candidate)).toEqual(["item", "reference", "envelope"]);
    fetch.mockResolvedValue(
      response(
        {
          version: 1,
          seed: candidate.item.seed,
          downloadUrl: client.downloadUrl(candidate.item.seed),
          itemSignature: candidate.item.itemSignature,
          createdAt: "2026-09-21T12:37:03.075Z",
          expiresAt: candidate.item.expiresAt,
        },
        201,
      ),
    );
    expect(await uploadCandidate(client, candidate)).toBe("active");
    const body = fetch.mock.calls[0]![1]!.body as string;
    expect(JSON.parse(body) as StorageItem).toEqual(candidate.item);
    for (const secret of [
      "Confidential message",
      "privateKey",
      "aesKey",
      "masterSignature",
    ])
      expect(body).not.toContain(secret);
    const seed = await openSealedSeed(
      sealedSeedFragment(candidate.envelope),
      identity.privateKey,
    );
    expect(seed).toEqual(candidate.reference.seed);
    // Seed-only links do not pin a creator. Download validates the item's own
    // signature; decryption does not establish the sender's identity.
    fetch.mockResolvedValueOnce(response(candidate.item));
    const item = await client.download(seed);
    expect(
      (await decryptStorageItem(item, item.creator, identity.privateKey))
        .plaintext,
    ).toBe("Confidential message 123");
    identity.privateKey.fill(0);
  });
  it("keeps a pending or lost upload on the original seed and recovers authoritative active state", async () => {
    const { client, fetch, candidate, identity, signer } = await fixture();
    fetch.mockResolvedValueOnce(
      response({ seed: candidate.item.seed, state: "pending" }, 202),
    );
    expect(await uploadCandidate(client, candidate)).toBe("pending");
    fetch.mockRejectedValueOnce(new TypeError("network details"));
    expect(await uploadCandidate(client, candidate)).toBe("uncertain");
    fetch.mockResolvedValueOnce(
      response({
        seed: candidate.item.seed,
        state: "active",
        createdAt: "2026-09-21T12:37:03.075Z",
        expiresAt: candidate.item.expiresAt,
      }),
    );
    fetch.mockResolvedValueOnce(response(candidate.item));
    expect(await recoverCandidate(client, candidate)).toBe("active");
    expect(signer.signMessage).toHaveBeenCalledOnce();
    expect(
      fetch.mock.calls.slice(2).every(([, init]) => init?.method === "GET"),
    ).toBe(true);
    expect(fetch.mock.calls[0]![1]!.body).toBe(fetch.mock.calls[1]![1]!.body);
    identity.privateKey.fill(0);
  });
  it("does not interpret network or malformed status responses as not-found", async () => {
    const { client, fetch, candidate, identity } = await fixture();
    fetch.mockResolvedValueOnce(response({ error: "garbage" }, 404));
    await expect(recoverCandidate(client, candidate)).rejects.toThrow();
    fetch.mockRejectedValueOnce(new TypeError("offline"));
    await expect(recoverCandidate(client, candidate)).rejects.toThrow();
    fetch.mockResolvedValueOnce(response({ garbage: true }, 201));
    expect(await uploadCandidate(client, candidate)).toBe("uncertain");
    identity.privateKey.fill(0);
  });
  it("discards preparation if the account changes during signing", async () => {
    const { client, candidate, signer, identity, fetch } = await fixture();
    let current = true;
    const signMessage = async (message: string) => {
      const signature = await signer.signMessage(message);
      current = false;
      return signature;
    };
    await expect(
      prepareMessage(
        client,
        "Draft",
        serializeReceiveCard(createReceiveCard(identity.publicKey)),
        candidate.reference.expiresAt,
        { address: signer.address, signMessage },
        () => current,
      ),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    identity.privateKey.fill(0);
  });
  it("distinguishes authoritative rejection, not-found, deleted and expired", async () => {
    const { client, fetch, candidate, identity } = await fixture();
    fetch.mockResolvedValueOnce(
      response(
        {
          error: {
            code: "RETENTION_NOT_ALLOWED",
            message: "unsupported expiration",
          },
        },
        400,
      ),
    );
    expect(await uploadCandidate(client, candidate)).toBe("rejected");
    fetch.mockResolvedValueOnce(
      response(
        { error: { code: "OBJECT_NOT_FOUND", message: "not found" } },
        404,
      ),
    );
    expect(await recoverCandidate(client, candidate)).toBe("not-found");
    fetch.mockResolvedValueOnce(
      response({ seed: candidate.item.seed, state: "expired" }),
    );
    expect(await recoverCandidate(client, candidate)).toBe("expired");
    fetch.mockResolvedValueOnce(
      response({
        seed: candidate.item.seed,
        state: "deleted",
        deletedBy: { publicKey: candidate.item.creator.publicKey },
        deletedAt: "2030-01-01T00:00:00Z",
      }),
    );
    expect(await recoverCandidate(client, candidate)).toBe("deleted");
    identity.privateKey.fill(0);
  });
});
