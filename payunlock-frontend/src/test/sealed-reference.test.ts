// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { Wallet } from "ethers";
import {
  encodeBase32,
  randomBytes,
  signingDescriptor,
  encryptPayload,
  wrapAesKey,
} from "@zkbytes/sdk";
import { deriveIdentity } from "@/exchange/identity";
import { createReceiveCard } from "@/exchange/receive-card";
import {
  sealReference,
  openSealedReference,
  sealedReferenceLink,
  parseSealedReferenceFragment,
  parseSealedReference,
  MAX_ENVELOPE_BYTES,
} from "@/exchange/sealed-reference";
const origins = {
  apiOrigin: "https://api.example.com",
  downloadOrigin: "https://files.example.com",
};
async function fixture() {
  const wallet = new Wallet("0x" + "0".repeat(63) + "1");
  const identity = await deriveIdentity(
    {
      kind: "fixture",
      walletName: "fixture",
      transport: "fixture",
      address: wallet.address,
      signMessage: (message) => wallet.signMessage(message),
      disconnect: async () => {},
    },
    "personal",
    () => true,
  );
  const reference = {
    version: 1,
    service: "zkbytes",
    ...origins,
    seed: encodeBase32(randomBytes(16)),
    expiresAt: "2030-01-01T00:00:00Z",
    expectedCreator: signingDescriptor(
      Uint8Array.from([
        0xd7, 0x5a, 0x98, 0x01, 0x82, 0xb1, 0x0a, 0xb7, 0xd5, 0x4b, 0xfe, 0xd3,
        0xc9, 0x64, 0x07, 0x3a, 0x0e, 0xe1, 0x72, 0xf3, 0xda, 0xa6, 0x23, 0x25,
        0xaf, 0x02, 0x1a, 0x68, 0xf7, 0x07, 0x51, 0x1a,
      ]),
    ),
  };
  const envelope = await sealReference(
    reference,
    createReceiveCard(identity.publicKey),
    origins,
  );
  return { identity, reference, envelope };
}
describe("sealed references", () => {
  it("round trips the whole reference locally and exposes only metadata and ciphertext in a link", async () => {
    const network = vi.spyOn(globalThis, "fetch");
    try {
      const { identity, reference, envelope } = await fixture();
      const link = sealedReferenceLink("http://127.0.0.1:5173", envelope);
      const restored = parseSealedReferenceFragment(new URL(link).hash);
      expect(restored).toEqual(envelope);
      expect(
        await openSealedReference(
          JSON.stringify(restored),
          identity.privateKey,
          origins,
        ),
      ).toEqual(reference);
      for (const secret of [
        reference.seed,
        reference.apiOrigin,
        reference.downloadOrigin,
        reference.expectedCreator.publicKey,
        "personal",
      ])
        expect(JSON.stringify(envelope)).not.toContain(secret);
      const second = await sealReference(
        reference,
        createReceiveCard(identity.publicKey),
        origins,
      );
      expect(second.context).not.toBe(envelope.context);
      expect(second.encryptedKey).not.toBe(envelope.encryptedKey);
      expect(second.encryptedPayload).not.toBe(envelope.encryptedPayload);
      expect(network).not.toHaveBeenCalled();
      identity.privateKey.fill(0);
    } finally {
      network.mockRestore();
    }
  });
  it("rejects wrong keys, tampering, mixed envelopes and unsupported destinations", async () => {
    const { identity, reference, envelope } = await fixture();
    const second = await sealReference(
      reference,
      createReceiveCard(identity.publicKey),
      origins,
    );
    const changes = [
      { version: 2 },
      { profile: "unknown" },
      { context: second.context },
      { encryptedKey: second.encryptedKey },
      { encryptedPayload: second.encryptedPayload },
      { recipientPublicKey: "A".repeat(43) + "=" },
    ];
    for (const change of changes)
      await expect(
        openSealedReference(
          JSON.stringify({ ...envelope, ...change }),
          identity.privateKey,
          origins,
        ),
      ).rejects.toThrow();
    await expect(
      openSealedReference(JSON.stringify(envelope), randomBytes(32), origins),
    ).rejects.toThrow();
    await expect(
      openSealedReference(JSON.stringify(envelope), identity.privateKey, {
        ...origins,
        apiOrigin: "https://other.example.com",
      }),
    ).rejects.toThrow();
    identity.privateKey.fill(0);
  });
  it("rejects an authenticated payload whose inner profile does not match the envelope", async () => {
    const { identity, reference, envelope } = await fixture();
    const {
      encryptedKey: _key,
      encryptedPayload: _payload,
      ...metadata
    } = envelope;
    void _key;
    void _payload;
    const encrypted = await encryptPayload(
      JSON.stringify({ ...metadata, profile: "different-domain", reference }),
    );
    try {
      const wrapped = await wrapAesKey(
        envelope.context,
        identity.publicKey,
        encrypted.aesKey,
      );
      await expect(
        openSealedReference(
          JSON.stringify({
            ...envelope,
            encryptedKey: wrapped.encryptedKey,
            encryptedPayload: encrypted.encryptedPayload,
          }),
          identity.privateKey,
          origins,
        ),
      ).rejects.toThrow();
    } finally {
      encrypted.aesKey.fill(0);
      identity.privateKey.fill(0);
    }
  });
  it("rejects extra/duplicate fields, oversized input and malformed fragments", async () => {
    const { identity, envelope, reference } = await fixture();
    const text = JSON.stringify(envelope);
    for (const input of [
      text.replace('"version":1', '"version":1,"version":1'),
      JSON.stringify({ ...envelope, extra: true }),
      " ".repeat(MAX_ENVELOPE_BYTES + 1),
    ])
      expect(() => parseSealedReference(input)).toThrow();
    for (const fragment of ["", "#", "#a=", "#%%%%", "a".repeat(12000)])
      expect(() => parseSealedReferenceFragment(fragment)).toThrow();
    for (const change of [
      { seed: "bad" },
      { extra: true },
      { apiOrigin: origins.apiOrigin + "/path" },
      { expectedCreator: { publicKey: "bad" } },
    ])
      await expect(
        sealReference(
          { ...reference, ...change },
          createReceiveCard(identity.publicKey),
          origins,
        ),
      ).rejects.toThrow();
    identity.privateKey.fill(0);
  });
});
