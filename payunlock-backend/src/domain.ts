import { z } from "zod";
export class ApiError extends Error {
  constructor(public statusCode: number, public code: string) { super(code); }
}
export const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(v => v.toLowerCase());
export const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(v => v.toLowerCase());
export const nonzeroHash = hash.refine(v => v !== `0x${"00".repeat(32)}`);
export const uint = z.string().regex(/^(0|[1-9][0-9]{0,77})$/).refine(v => BigInt(v) < 2n ** 256n);
const uint64 = uint.refine(v => BigInt(v) < 2n ** 64n);
export const orderId = uint.refine(v => BigInt(v) > 0n);
export const receiving = z.strictObject({ nonce: nonzeroHash, publicKey: nonzeroHash });
export const page = z.strictObject({ limit: z.coerce.number().int().min(1).max(50).default(20), after: z.string().max(100).optional() });
export const productInput = z.strictObject({
  title: z.string().trim().min(1).max(160), description: z.string().max(12000),
  images: z.array(z.object({ id: z.uuid() })).max(8).refine(v => new Set(v.map(i => i.id)).size === v.length).optional(),
  visibility: z.enum(["draft", "public", "hidden"]),
  draftTerms: z.strictObject({ token: address, price: uint.refine(v => BigInt(v) > 0n),
    eventEnd: uint64.nullable(), reviewWindow: uint64.nullable(), commitmentWindow: z.number().int().min(1).max(4294967295) }),
});
export type Receiving = z.infer<typeof receiving>;
export interface Order {
  state: number; buyer: string; seller: string; productKey: string; requestId: string;
  buyerReceiving: Receiving; sellerReceiving: Receiving;
  terms: { token: string; price: string; hasEventEnd: boolean; eventEnd: string; reviewWindow: string; responseWindow: string; commitmentWindow: string };
  deliveryHash: string; publicationDeadline: string; reviewDeadline: string; responseDeadline: string; turn: string;
}
export interface Assignment { wallet: string; publicKey: string; keyVersion: string; revision: string; fee: string; requester: string; handoverRecorded: boolean }
export interface Block { number: number; hash: string; timestamp: number }
export interface ChainSnapshot { block: Block; order: Order; assignment?: Assignment; canceled: boolean }
export const json = (value: unknown): string => JSON.stringify(value, (_, v: unknown) => typeof v === "bigint" ? v.toString() : v);
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, "INVALID_REQUEST");
  return result.data;
}
