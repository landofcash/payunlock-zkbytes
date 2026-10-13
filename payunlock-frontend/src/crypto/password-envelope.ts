import {argon2id} from "hash-wasm";
import {decodeBase64, encodeBase64, randomBytes} from "@zkbytes/sdk";
import {z} from "zod";
import {canonical, utf8} from "./encoding";

const EnvelopeSchema = z.strictObject({
  version: z.literal(1), kdf: z.literal("argon2id-19456-3-1"),
  salt: z.string().max(24), iv: z.string().max(16), ciphertext: z.string().max(8_000_000),
});
export type PasswordEnvelope = z.infer<typeof EnvelopeSchema>;

async function key(password: string, salt: Uint8Array) {
  if (password.length < 12 || password.length > 1024) throw new Error("Use a passphrase of 12–1024 characters.");
  const bytes = await argon2id({
    password,
    salt,
    iterations: 3,
    parallelism: 1,
    memorySize: 19456,
    hashLength: 32,
    outputType: "binary"
  });
  try {
    return await crypto.subtle.importKey("raw", new Uint8Array(bytes), "AES-GCM", false, ["encrypt", "decrypt"]);
  } finally {
    bytes.fill(0);
  }
}

export async function encryptWithPassword(plaintext: string, password: string, binding: unknown): Promise<PasswordEnvelope> {
  const salt = randomBytes(16), iv = randomBytes(12), bytes = utf8(plaintext);
  try {
    const ciphertext = await crypto.subtle.encrypt({
      name: "AES-GCM",
      iv: new Uint8Array(iv),
      additionalData: utf8(canonical(binding))
    }, await key(password, salt), bytes);
    return {
      version: 1,
      kdf: "argon2id-19456-3-1",
      salt: encodeBase64(salt),
      iv: encodeBase64(iv),
      ciphertext: encodeBase64(new Uint8Array(ciphertext))
    };
  } finally {
    bytes.fill(0);
  }
}

export async function decryptWithPassword(input: unknown, password: string, binding: unknown): Promise<string> {
  const e = EnvelopeSchema.parse(input);
  const decrypted = await crypto.subtle.decrypt({
    name: "AES-GCM",
    iv: new Uint8Array(decodeBase64(e.iv, 12)),
    additionalData: utf8(canonical(binding))
  }, await key(password, decodeBase64(e.salt, 16)), new Uint8Array(decodeBase64(e.ciphertext)));
  const bytes = new Uint8Array(decrypted);
  try {
    return new TextDecoder("utf-8", {fatal: true}).decode(bytes);
  } finally {
    bytes.fill(0);
  }
}
