import fp from "fastify-plugin";
import { Pool } from "pg";

declare module "fastify" {
  interface FastifyInstance { db: Pool }
}

export const databasePlugin = fp<{ connectionString: string }>(async (app, options) => {
  const pool = new Pool({ connectionString: options.connectionString, max: 10, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  pool.on("error", () => app.log.error("Idle database connection failed"));
  app.decorate("db", pool);
  app.addHook("onClose", async () => { await pool.end(); });
}, { name: "database" });
