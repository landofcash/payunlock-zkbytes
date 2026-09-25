import { fileURLToPath } from "node:url";
import { runner } from "node-pg-migrate";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const direction = process.argv[2];
if (direction !== "up") throw new Error("Only forward deployment migrations are supported by this command");
try {
  await runner({ databaseUrl, dir: fileURLToPath(new URL("../../migrations/", import.meta.url)), direction, migrationsTable: "pgmigrations", checkOrder: true, singleTransaction: true, log: () => {}, logger: { info: () => {}, warn: () => {}, error: () => {} } });
  console.info("Database migrations applied successfully.");
} catch {
  console.error("Database migration failed. Verify database access and migration order.");
  process.exitCode = 1;
}
