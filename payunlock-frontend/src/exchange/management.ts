import {
  clearItemKeys,
  encodeBase64,
  parseStrictJson,
  signSeedAndDerive,
  ZkbytesClient,
  type MasterMessageSigner,
  type ZkbytesReference,
} from "@zkbytes/sdk";
import { MAX_REFERENCE_BYTES, validateReference } from "./sealed-reference";

export function importReference(text: string, client: ZkbytesClient) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > MAX_REFERENCE_BYTES) throw new Error("Invalid reference.");
  return validateReference(parseStrictJson(bytes), client);
}

export async function recoverReference(
  client: ZkbytesClient,
  reference: ZkbytesReference,
) {
  const result = await client.recoverUpload(
    reference.seed,
    reference.expectedCreator,
  );
  if (
    result.outcome === "active" &&
    (result.item.expiresAt !== reference.expiresAt ||
      result.status.expiresAt !== reference.expiresAt)
  )
    throw new Error("Reference mismatch.");
  return result.outcome;
}

export async function prepareDeletion(
  client: ZkbytesClient,
  reference: ZkbytesReference,
  signer: MasterMessageSigner,
  isCurrent: () => boolean,
) {
  const check = () => {
    if (!isCurrent()) throw new Error("Operation cancelled.");
  };
  check();
  const item = await client.downloadAndVerify(
    reference.seed,
    reference.expectedCreator,
  );
  check();
  if (item.expiresAt !== reference.expiresAt)
    throw new Error("Reference mismatch.");
  if (!item.managers.length) throw new Error("NO_MANAGER");
  let supplied: Uint8Array | undefined;
  const keys = await signSeedAndDerive(reference.seed, {
    address: signer.address,
    async signMessage(message) {
      check();
      const signature = await signer.signMessage(message);
      if (signature instanceof Uint8Array) supplied = signature;
      check();
      return signature;
    },
  }).finally(() => supplied?.fill(0));
  let disposed = false;
  const dispose = () => {
    disposed = true;
    clearItemKeys(keys);
  };
  try {
    check();
    const publicKey = encodeBase64(keys.signingPublicKey);
    const managerIndex = item.managers.findIndex(
      (manager) => manager.publicKey === publicKey,
    );
    if (managerIndex < 0) throw new Error("NO_MANAGER");
    return {
      publicKey,
      managerIndex,
      dispose,
      async submit(
        current: () => boolean,
        request: typeof fetch = globalThis.fetch.bind(globalThis),
      ) {
        const guard = () => {
          check();
          if (disposed || !current()) throw new Error("Operation cancelled.");
        };
        // Guard both SDK requests: a wallet change during the challenge must not
        // send the subsequent signed deletion action.
        const guarded = new ZkbytesClient({
          apiOrigin: client.apiOrigin,
          downloadOrigin: client.downloadOrigin,
          fetch: async (url, init) => {
            guard();
            const response = await request(url, init);
            guard();
            return response;
          },
        });
        try {
          guard();
          return await guarded.delete(
            reference.seed,
            managerIndex,
            keys.signingPrivateKey,
          );
        } finally {
          dispose();
        }
      },
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

export type PreparedDeletion = Awaited<ReturnType<typeof prepareDeletion>>;

export const recoveryMessages = {
  active: "Upload confirmed. The stored item matches this reference.",
  pending:
    "Upload is still pending. Keep the original reference. Do not resend.",
  deleted:
    "The item is logically deleted. Physical removal may still be pending; cached content can remain available for up to 60 seconds.",
  expired: "The item has expired.",
  "not-found":
    "The service confirms that this item was not found. You may prepare a new message under Encrypt. This reference cannot recreate the original encrypted upload.",
} as const;
