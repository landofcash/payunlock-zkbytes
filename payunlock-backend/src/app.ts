import Fastify, { LogController } from "fastify";
import cors from "@fastify/cors";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { Config } from "./config.js";
import { databasePlugin } from "./plugins/database.js";
import { healthRoutes } from "./routes/health.js";

export function buildApp(config: Config) {
  const app = Fastify({ logger: { level: config.LOG_LEVEL, redact: ["req.headers.authorization", "req.headers.cookie", "res.headers.set-cookie"] }, logController: new LogController({ disableRequestLogging: true }) });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(cors, { origin: config.API_ORIGINS, credentials: false });
  app.register(databasePlugin, { connectionString: config.DATABASE_URL });
  app.register(healthRoutes);
  return app;
}
