import { z } from "zod";

const httpUrl = z.url().refine((value) => URL.canParse(value) && ["http:", "https:"].includes(new URL(value).protocol));
const csv = <T extends z.ZodType>(item: T) => z.preprocess((value) => typeof value === "string" ? value.split(",").map((entry) => entry.trim()) : value, z.array(item).min(1));
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_HOST: z.string().min(1).default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4321),
  DATABASE_URL: z.url().refine((value) => URL.canParse(value) && ["postgres:", "postgresql:"].includes(new URL(value).protocol)),
  API_ORIGINS: csv(httpUrl.refine((value) => URL.canParse(value) && new URL(value).origin === value)),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  MONAD_TESTNET_RPC_URL: httpUrl,
  CHAIN_ID: z.coerce.number().pipe(z.literal(10143)),
  ALLOWED_CHAIN_IDS: csv(z.coerce.number().pipe(z.literal(10143))),
  ALLOWED_PAYMENT_ASSETS: csv(z.string().regex(/^0x[0-9a-fA-F]{40}$/)),
  ZKBYTES_SERVICE_URL: httpUrl,
  ZKBYTES_PROFILE: z.literal("zkbytes-wallet-eip191-sha256-secp256k1-hpke-v1"),
});

export type Config = z.infer<typeof schema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    // Report field names only: a validation error must not disclose credentials.
    throw new Error(`Invalid configuration: ${[...new Set(result.error.issues.map((issue) => issue.path.join(".")))].join(", ")}`);
  }
  return result.data;
}
