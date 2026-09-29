import { decodeBase64, encodeBase64, randomBytes } from "@zkbytes/sdk";
import { z } from "zod";
import { canonical, utf8 } from "./encoding";
import { encryptWithPassword, decryptWithPassword } from "./password-envelope";

// Strings are supported only for existing passphrase drafts and non-delivery operations.
export type DraftCredential = CryptoKey | string;
const schema = z.object({ version: z.literal(2), protection: z.literal("offer-key-v1"), iv: z.string(), ciphertext: z.string().max(8_000_000) });
export const isOfferDraft = (value: unknown) => schema.safeParse(value).success;
export async function offerDraftKey(privateKey: Uint8Array, context: unknown): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new Uint8Array(privateKey), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: utf8("payunlock-offer-draft-v1"), info: utf8(canonical(context)) }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export async function encryptDraft(text: string, credential: DraftCredential, binding: unknown) {
  if (typeof credential === "string") return encryptWithPassword(text, credential, binding);
  const iv = randomBytes(12), bytes = utf8(text);
  try {
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(iv), additionalData: utf8(canonical(binding)) }, credential, bytes);
    return { version: 2 as const, protection: "offer-key-v1" as const, iv: encodeBase64(iv), ciphertext: encodeBase64(new Uint8Array(encrypted)) };
  } finally { bytes.fill(0); }
}
export async function decryptDraft(value: unknown, credential: DraftCredential, binding: unknown) {
  if (typeof credential === "string") return decryptWithPassword(value, credential, binding);
  const envelope = schema.parse(value);
  const bytes = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(decodeBase64(envelope.iv, 12)), additionalData: utf8(canonical(binding)) }, credential, new Uint8Array(decodeBase64(envelope.ciphertext))));
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  finally { bytes.fill(0); }
}
