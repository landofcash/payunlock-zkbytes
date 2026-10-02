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
  ENVIO_GRAPHQL_URL: z.preprocess(value => value === "" ? undefined : value, httpUrl.optional()),
  ENVIO_HASURA_ADMIN_SECRET: z.preprocess(value => value === "" ? undefined : value, z.string().min(16).optional()),
  MONAD_TESTNET_RPC_URL: httpUrl,
  CHAIN_ID: z.coerce.number().pipe(z.literal(10143)),
  ALLOWED_CHAIN_IDS: csv(z.coerce.number().pipe(z.literal(10143))),
  ALLOWED_PAYMENT_ASSETS: csv(z.string().regex(/^0x[0-9a-fA-F]{40}$/)),
  PAYUNLOCK_DEPLOYMENT_VERSION: z.literal("v5").default("v5"),
  RELAYER_PRIVATE_KEY: z.preprocess(v => v === "" ? undefined : v, z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional()),
  RELAYER_DAILY_BUDGET_WEI: z.preprocess(v => v === "" ? undefined : v, z.string().regex(/^[1-9][0-9]*$/).optional()),
  RELAYER_MAX_GAS_LIMIT: z.coerce.number().int().min(21000).max(10000000).default(2000000),
  RELAYER_MAX_FEE_PER_GAS_WEI: z.preprocess(v => v === "" ? undefined : v, z.string().regex(/^[1-9][0-9]*$/).optional()),
  ZKBYTES_OFFER_NEW: z.enum(["true", "false"]).default("true").transform(v => v === "true"),
  ZKBYTES_SERVICE_URL: httpUrl,
  ZKBYTES_DOWNLOAD_ORIGIN: httpUrl.optional(),
  ZKBYTES_MAX_RETENTION_SECONDS: z.coerce.number().int().min(0).optional(),
  STORAGE_SERVICES_JSON: z.string().optional().transform((value, ctx) => {
    if (!value) return [];
    try {
      return z.array(z.strictObject({ id: z.number().int().min(2).max(4294967295), adapter: z.literal("zkbytes-v1"), apiOrigin: httpUrl.refine(v => new URL(v).origin === v), downloadOrigin: httpUrl.refine(v => new URL(v).origin === v), maxRetentionSeconds: z.number().int().refine(n => n === 0 || n >= 31536000), offerNew: z.boolean() })).refine(rows => new Set(rows.map(row => row.id)).size === rows.length).parse(JSON.parse(value));
    } catch { ctx.addIssue({ code: "custom", message: "Invalid storage adapter mapping" }); return z.NEVER; }
  }),
  ZKBYTES_PROFILE: z.literal("zkbytes-wallet-eip191-hkdfsha256-ed25519-x25519-hpke-v1"),
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
