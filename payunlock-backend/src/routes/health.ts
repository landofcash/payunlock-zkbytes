import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { HealthResponseSchema, ReadinessResponseSchema } from "@payunlock/api-contracts";
import { HealthRepository } from "../repositories/health-repository.js";
import { HealthService } from "../services/health-service.js";

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new HealthService(new HealthRepository(app.db));
  app.get("/health", { schema: { response: { 200: HealthResponseSchema } } }, async () => ({ status: "ok", service: "payunlock-api" } as const));
  app.get("/ready", { schema: { response: { 200: ReadinessResponseSchema, 503: ReadinessResponseSchema } } }, async (_request, reply) => {
    const result = await service.readiness();
    return reply.code(result.status === "ready" ? 200 : 503).send(result);
  });
};
