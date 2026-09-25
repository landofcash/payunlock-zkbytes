import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  envDir: "..",
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  plugins: [react(), tailwindcss()],
  server: { host: "127.0.0.1", port: 4320, strictPort: true },
  test: { environment: "jsdom", setupFiles: ["./src/test/setup.ts"] },
});
