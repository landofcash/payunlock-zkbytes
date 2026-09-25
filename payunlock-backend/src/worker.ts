import { loadConfig } from "./config.js";

const config = loadConfig();
console.info(`Worker configuration valid for chain ${config.CHAIN_ID}. Indexing starts in Phase 4 after an escrow deployment exists; no events processed.`);
