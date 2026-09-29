// @vitest-environment node
import { expect, it } from "vitest";
import { Wallet } from "ethers";
import {
  createReceiveCard,
  parseReceiveCard,
  receiveCardMessage,
  receiveLink,
  serializeReceiveCard,
  signReceiveCard } from "@/exchange/receive-card";
import { prepareMessage } from "@/exchange/send";
import { ZkbytesClient } from "@zkbytes/sdk";
const key = "E/frDPU+6KR8X6eFQ95jCOwDiIH1CCwoRmNqz+IxoyI=";
const wallet = new Wallet("0x" + "0".repeat(63) + "1");

it("round-trips unsigned and endorsed Receive links and rejects malformed links", async () => {
  for (const card of [
    createReceiveCard(key),
    await signReceiveCard(key, wallet, () => true),
  ]) {
    const link = receiveLink("https://lab.example", card);
    expect(link).toBe(`https://lab.example/send#${serializeReceiveCard(card)}`);
    expect(parseReceiveCard(link)).toEqual(card);
    expect(parseReceiveCard(`  ${link}  `)).toEqual(card);
    for (const invalid of [
      link.replace("/send#", "/open#"),
      link.replace("https:", "javascript:"),
      link.replace("/send#", "/send?recipient=ignored#"),
      link.replace("lab.example", "user@lab.example"),
      link + ".extra",
      "https://lab.example/send#",
      "x".repeat(2049),
    ])
      expect(() => parseReceiveCard(invalid)).toThrow();
  }
});

it("pins compact encoding and the exact purpose-bound signing message, rejecting JSON imports", () => {
  const card = createReceiveCard(key);
  const compact = "zkbytes.v1.E_frDPU-6KR8X6eFQ95jCOwDiIH1CCwoRmNqz-IxoyI";
  expect(serializeReceiveCard(card)).toBe(compact);
  expect(compact).toHaveLength(54);
  expect(parseReceiveCard(compact)).toEqual(card);
  expect(() => parseReceiveCard(JSON.stringify(card))).toThrow();
  expect(receiveCardMessage(key)).toBe(
    "zkbytes Receive card\nVersion: 1\nPublic key: E_frDPU-6KR8X6eFQ95jCOwDiIH1CCwoRmNqz-IxoyI",
  );
});

it("verifies signed cards and sends to the endorsed key without changing item format", async () => {
  const signed = await signReceiveCard(key, wallet, () => true);
  const text = serializeReceiveCard(signed);
  expect(text).toHaveLength(185);
  expect(parseReceiveCard(text)).toEqual(signed);
  expect(signed.endorsement?.walletAddress).toBe(wallet.address.toLowerCase());
  const client = new ZkbytesClient({
    apiOrigin: "https://api.test",
    downloadOrigin: "https://files.test" });
  const candidate = await prepareMessage(
    client,
    "Signed recipient",
    text,
    "2035-01-01T00:00:00Z",
    wallet,
    () => true,
  );
  expect(candidate.envelope.recipientPublicKey).toBe(key);
});

it("rejects changes to the key, claimed wallet, signature, purpose, version and field count", async () => {
  const signed = serializeReceiveCard(
    await signReceiveCard(key, wallet, () => true),
  );
  const fields = signed.split(".");
  for (const value of [
    signed.replace(".v1.", ".v2."),
    signed + ".extra",
    fields.slice(0, 4).join("."),
    [
      fields[0],
      fields[1],
      "V8XMRBeA_lFxD6x7wjx0MJNasK6KIzId0nMDICfTq2s",
      fields[3],
      fields[4],
    ].join("."),
    signed.replace(fields[3]!, "0x" + "2".repeat(40)),
    signed.replace(fields[4]!, "A".repeat(87)),
    fields.slice(0, 3).join(".") + "=",
  ])
    expect(() => parseReceiveCard(value)).toThrow();
  const wrongPurpose = await wallet.signMessage(key);
  await expect(
    signReceiveCard(
      key,
      { address: wallet.address, signMessage: async () => wrongPurpose },
      () => true,
    ),
  ).rejects.toThrow();
});

it("discards stale signing results and wipes supplied byte signatures", async () => {
  let current = true;
  const bytes = Uint8Array.from(
    Buffer.from(
      (await wallet.signMessage(receiveCardMessage(key))).slice(2),
      "hex",
    ),
  );
  await expect(
    signReceiveCard(
      key,
      {
        address: wallet.address,
        signMessage: async () => {
          current = false;
          return bytes;
        } },
      () => current,
    ),
  ).rejects.toThrow("Session changed");
  expect(bytes.every((value) => value === 0)).toBe(true);
});
