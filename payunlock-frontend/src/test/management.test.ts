// @vitest-environment node
import { expect, it, vi } from "vitest";
import { Wallet } from "ethers";
import {
  clearItemKeys,
  prepareItem,
  ZkbytesClient,
  SIGNATURE_SCHEME,
} from "@zkbytes/sdk";
import {
  importReference,
  prepareDeletion,
  recoverReference,
} from "@/exchange/management";

async function fixture(noManagers = false) {
  const signer = new Wallet("0x" + "0".repeat(63) + "2");
  const prepared = await prepareItem({
    signer,
    plaintext: "Management test",
    expiresAt: "2035-01-01T00:00:00Z",
    ...(noManagers ? { managers: [] } : {}),
  });
  clearItemKeys(prepared.keys);
  const request = vi.fn<typeof fetch>(async () => Response.json(prepared.item));
  const client = new ZkbytesClient({
    apiOrigin: "https://api.test",
    downloadOrigin: "https://files.test",
    fetch: request,
  });
  return {
    signer,
    item: prepared.item,
    request,
    client,
    reference: client.createReference(prepared.item),
  };
}

it("imports only bounded references matching configured origins without making requests", async () => {
  const { client, reference, request } = await fixture();
  expect(importReference(JSON.stringify(reference), client)).toEqual(reference);
  for (const value of [
    "x".repeat(4097),
    JSON.stringify({ ...reference, apiOrigin: "https://other.test" }),
    JSON.stringify({ ...reference, extra: true }),
    "{}",
  ]) {
    expect(() => importReference(value, client)).toThrow();
  }
  expect(request).not.toHaveBeenCalled();
});

it.each(["active", "pending", "deleted", "expired", "not-found"] as const)(
  "recovers %s from the authoritative API",
  async (state) => {
    const { client, reference, request, item } = await fixture();
    request.mockImplementation(async (url) => {
      if (String(url).startsWith(client.downloadOrigin))
        return Response.json(item);
      if (state === "not-found")
        return Response.json(
          { error: { code: "OBJECT_NOT_FOUND", message: "Missing" } },
          { status: 404 },
        );
      return Response.json(
        {
          seed: reference.seed,
          state,
          ...(state === "active"
            ? {
                createdAt: "2026-09-21T00:00:00Z",
                expiresAt: reference.expiresAt,
              }
            : {}),
          ...(state === "deleted"
            ? {
                deletedBy: { publicKey: item.creator.publicKey },
                deletedAt: "2026-09-21T00:00:00Z",
              }
            : {}),
        },
        { status: state === "pending" ? 202 : 200 },
      );
    });
    await expect(recoverReference(client, reference)).resolves.toBe(state);
    expect(request).toHaveBeenCalledTimes(state === "active" ? 2 : 1);
  },
);

it("keeps unavailable and mismatched recovery uncertain", async () => {
  const { client, reference, request } = await fixture();
  request.mockResolvedValue(
    Response.json(
      { error: { code: "SERVICE_UNAVAILABLE", message: "Unavailable" } },
      { status: 503 },
    ),
  );
  await expect(recoverReference(client, reference)).rejects.toThrow();
  vi.spyOn(client, "recoverUpload").mockResolvedValue({
    outcome: "active",
    item: { expiresAt: "2034-01-01T00:00:00Z" },
    status: { expiresAt: reference.expiresAt },
  } as never);
  await expect(recoverReference(client, reference)).rejects.toThrow(
    "Reference mismatch",
  );
});

it("rejects a wrong manager and empty managers before requesting a challenge", async () => {
  const { client, reference, request } = await fixture();
  await expect(
    prepareDeletion(
      client,
      reference,
      new Wallet("0x" + "0".repeat(63) + "3"),
      () => true,
    ),
  ).rejects.toThrow("NO_MANAGER");
  expect(request).toHaveBeenCalledTimes(1);
  const empty = await fixture(true);
  const sign = vi.spyOn(empty.signer, "signMessage");
  await expect(
    prepareDeletion(empty.client, empty.reference, empty.signer, () => true),
  ).rejects.toThrow("NO_MANAGER");
  expect(sign).not.toHaveBeenCalled();
});

it("prepares an exact manager index, disposes on cancel, and blocks a late challenge after account change", async () => {
  const { client, reference, signer } = await fixture();
  const cancelled = await prepareDeletion(
    client,
    reference,
    signer,
    () => true,
  );
  expect(cancelled.managerIndex).toBe(0);
  cancelled.dispose();
  const noRequest = vi.fn<typeof fetch>();
  await expect(cancelled.submit(() => true, noRequest)).rejects.toThrow();
  expect(noRequest).not.toHaveBeenCalled();
  let current = true;
  const pending = await prepareDeletion(
    client,
    reference,
    signer,
    () => current,
  );
  const request = vi.fn<typeof fetch>(async () => {
    current = false;
    return Response.json({});
  });
  await expect(pending.submit(() => current, request)).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(1);
});

it("submits the SDK challenge/action only on confirmation and reports physical removal pending", async () => {
  const { client, reference, signer } = await fixture();
  const prepared = await prepareDeletion(client, reference, signer, () => true);
  const challengeId = "11111111-1111-4111-8111-111111111111";
  const issuedAt = "2026-09-21T00:00:00Z";
  const expiresAt = "2035-01-01T00:00:00Z";
  const accepted = {
    version: 1,
    seed: reference.seed,
    state: "deleted",
    deletedBy: { publicKey: prepared.publicKey },
    deletedAt: issuedAt,
    physicalDeletion: "pending",
  };
  const request = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith("/challenges")
      ? Response.json({
          version: 1,
          challengeId,
          seed: reference.seed,
          managerIndex: prepared.managerIndex,
          action: "delete",
          parameters: {},
          signatureScheme: SIGNATURE_SCHEME,
          messageEncoding: "utf-8",
          issuedAt,
          expiresAt,
          message: [
            "zkbytes management v1",
            `Audience: ${client.apiOrigin}`,
            `Seed: ${reference.seed}`,
            `Manager index: ${prepared.managerIndex}`,
            "Action: delete",
            `Challenge: ${challengeId}`,
            `Issued: ${issuedAt}`,
            `Expires: ${expiresAt}`,
          ].join("\n"),
        })
      : Response.json(accepted, { status: 202 }),
  );
  await expect(prepared.submit(() => true, request)).resolves.toEqual(accepted);
  expect(request).toHaveBeenCalledTimes(2);
  await expect(prepared.submit(() => true, request)).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(2);
});
