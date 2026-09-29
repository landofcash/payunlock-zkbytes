import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
const file = new URL("../../.env", import.meta.url);
let current = readFileSync(file, "utf8");
const defaults = {
  ENVIO_PG_PASSWORD: randomBytes(24).toString("hex"),
  ENVIO_HASURA_ADMIN_SECRET: randomBytes(32).toString("hex"),
  ENVIO_GRAPHQL_URL: "http://127.0.0.1:8082/v1/graphql",
};
for (const [key, value] of Object.entries(defaults)) {
  const expression = new RegExp(`^${key}=([^\\r\\n]*)`, "m");
  const existing = current.match(expression);
  if (!existing) current += `\n${key}=${value}\n`;
  else if (!existing[1].trim()) current = current.replace(expression, `${key}=${value}`);
}
writeFileSync(file, current);
console.info("Local indexer settings prepared; existing settings preserved.");
