import {buildApp} from "./app.js";
import {loadConfig} from "./config.js";

const config = loadConfig();
const app = buildApp(config);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close();
  });
}
try {
  await app.listen({host: config.API_HOST, port: config.API_PORT});
} catch {
  app.log.error("API startup failed; check bind address and port");
  await app.close();
  process.exitCode = 1;
}
