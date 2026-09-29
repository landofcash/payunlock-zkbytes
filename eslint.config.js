import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/artifacts/**", "**/cache/**", "**/types/ethers-contracts/**", "**/ignition/deployments/**", "**/.envio/**", "**/envio-env.d.ts", "doc/local/**", "docs/local/**", "output/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ["**/*.cjs"], languageOptions: { globals: { exports: "readonly" } } },
  { files: ["**/*.mjs", "**/*.js"], languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly", fetch: "readonly", AbortSignal: "readonly", Buffer: "readonly" } } },
);
