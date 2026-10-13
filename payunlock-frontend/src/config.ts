import {z} from "zod";

const schema = z.object({
  VITE_API_ORIGIN: z.url().refine((value) => URL.canParse(value) && ["http:", "https:"].includes(new URL(value).protocol) && new URL(value).origin === value),
  VITE_CHAIN_ID: z.coerce.number().pipe(z.literal(10143)),
  VITE_WALLETS_ENABLED: z.enum(["true", "false"]).default("false"),
  VITE_REOWN_PROJECT_ID: z.string().default(""),
}).superRefine((value, context) => {
  if (value.VITE_REOWN_PROJECT_ID && (!/^[a-fA-F0-9]{32}$/.test(value.VITE_REOWN_PROJECT_ID) || /^0+$/.test(value.VITE_REOWN_PROJECT_ID))) {
    context.addIssue({code: "custom", path: ["VITE_REOWN_PROJECT_ID"], message: "A connector project ID is required"});
  }
});

export function loadFrontendConfig(env: Record<string, unknown>) {
  const result = schema.safeParse(env);
  if (!result.success) throw new Error(`Invalid frontend configuration: ${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}`);
  return result.data;
}
