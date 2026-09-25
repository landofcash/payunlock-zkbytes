import { z } from "zod";

export const HealthResponseSchema = z.object({ status: z.literal("ok"), service: z.literal("payunlock-api") });
export const ReadinessResponseSchema = z.object({ status: z.enum(["ready", "unavailable"]), database: z.enum(["ready", "unavailable"]) });
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type ReadinessResponse = z.infer<typeof ReadinessResponseSchema>;
