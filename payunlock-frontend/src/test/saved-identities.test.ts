import { expect, it } from "vitest";
import { IDENTITY_PROFILE } from "@/exchange/identity";
import {
  mergeIdentities,
  parseIdentityBackup,
  serializeIdentityBackup,
  type SavedIdentity,
} from "@/exchange/saved-identities";

const identity: SavedIdentity = {
  walletAddress: "0x" + "a".repeat(40),
  walletKind: "metamask",
  label: "Personal Key",
  publicKey: "E/frDPU+6KR8X6eFQ95jCOwDiIH1CCwoRmNqz+IxoyI=",
  profile: IDENTITY_PROFILE,
};
it("round trips only identity metadata and deduplicates by wallet and exact label", () => {
  const text = serializeIdentityBackup([identity]);
  expect(parseIdentityBackup(text)).toEqual([identity]);
  expect(text).not.toMatch(/privateKey|signature|password/);
  expect(mergeIdentities([identity], [identity])).toEqual([identity]);
  expect(
    mergeIdentities([identity], [{ ...identity, label: "personal key" }]),
  ).toHaveLength(2);
  expect(
    mergeIdentities(
      [identity],
      [{ ...identity, walletAddress: "0x" + "b".repeat(40) }],
    ),
  ).toHaveLength(2);
});
it("rejects unknown fields, private keys, invalid profiles and oversized or malformed backups", () => {
  const envelope = {
    format: "zkbytes-identities",
    version: 1,
    identities: [identity],
  };
  for (const invalid of [
    { ...envelope, version: 2 },
    { ...envelope, privateKey: "secret" },
    { ...envelope, identities: [{ ...identity, privateKey: "secret" }] },
    { ...envelope, identities: [{ ...identity, profile: "unknown" }] },
    { ...envelope, identities: [{ ...identity, walletAddress: "invalid" }] },
    { ...envelope, identities: [{ ...identity, label: "trailing " }] },
    { ...envelope, identities: [{ ...identity, publicKey: "invalid" }] },
    { ...envelope, identities: Array(101).fill(identity) },
  ])
    expect(() => parseIdentityBackup(JSON.stringify(invalid))).toThrow();
  expect(() => parseIdentityBackup(" ".repeat(65537))).toThrow();
  expect(() => parseIdentityBackup('{"version":1,"version":1}')).toThrow();
});
it("rejects a conflicting public key atomically", () => {
  const original = [identity];
  expect(() =>
    mergeIdentities(original, [{ ...identity, publicKey: "different" }]),
  ).toThrow(/different public key/);
  expect(original).toEqual([identity]);
});
