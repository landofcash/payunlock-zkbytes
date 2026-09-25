import { Wallet } from "ethers";
import type { LabWalletAdapter } from "./types";

// Public, deliberately insecure development identity. Never fund this account.
const FIXTURE_PRIVATE_KEY = "0x" + "0".repeat(63) + "1";
export const fixtureAdapter: LabWalletAdapter = {
  kind: "fixture",
  label: "Development fixture",
  async connect() {
    if (!import.meta.env.DEV) throw new Error("Fixture unavailable.");
    const wallet = new Wallet(FIXTURE_PRIVATE_KEY);
    let connected = true;
    return {
      kind: "fixture",
      walletName: "Development fixture",
      transport: "fixture",
      address: wallet.address,
      async signMessage(message) {
        if (!connected) throw new Error("Fixture disconnected.");
        return wallet.signMessage(message);
      },
      async disconnect() {
        connected = false;
      },
    };
  },
};
