import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

const root = new URL("../", import.meta.url);
const template = await readFile(new URL(".env.example", root), "utf8");
try {
  await writeFile(new URL(".env", root), template.replaceAll("REPLACE_LOCAL_PASSWORD", randomBytes(24).toString("hex")), { flag: "wx", mode: 0o600 });
  console.log("Created .env with a generated local database password. Wallet/storage integration remains disabled.");
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log("Existing .env preserved.");
}
