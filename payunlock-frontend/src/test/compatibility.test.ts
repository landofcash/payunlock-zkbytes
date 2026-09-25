// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Wallet } from "ethers";
import { checkCompatibility } from "@/wallet/compatibility";
import type { LabWalletSession } from "@/wallet/types";

const wallet = new Wallet("0x" + "0".repeat(63) + "1");
describe("published SDK signer compatibility", () => {
  it.each(["unsupported", "wrong-account"] as const)(
    "classifies %s signatures before deriving keys",
    async (kind) => {
      let calls = 0;
      const otherWallet = new Wallet("0x" + "0".repeat(63) + "2");
      const session: LabWalletSession = {
        kind: "fixture",
        walletName: "test",
        transport: "fixture",
        address: wallet.address,
        async signMessage(message) {
          calls++;
          return kind === "unsupported"
            ? "0x1234"
            : otherWallet.signMessage(message);
        },
        async disconnect() {},
      };
      await expect(
        checkCompatibility(session, () => true),
      ).rejects.toMatchObject({ kind });
      expect(calls).toBe(1);
    },
  );
  it("derives reproducible keys using two signatures of the same message", async () => {
    const messages: string[] = [];
    const session: LabWalletSession = {
      kind: "fixture",
      walletName: "test",
      transport: "fixture",
      address: wallet.address,
      async signMessage(message) {
        messages.push(message);
        return wallet.signMessage(message);
      },
      async disconnect() {},
    };
    expect(await checkCompatibility(session, () => true)).toBe(true);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe(messages[1]);
  });
  it("does not request a second signature after a session changes", async () => {
    let current = true;
    let signatures = 0;
    const session: LabWalletSession = {
      kind: "fixture",
      walletName: "test",
      transport: "fixture",
      address: wallet.address,
      async signMessage(message) {
        signatures++;
        current = false;
        return wallet.signMessage(message);
      },
      async disconnect() {},
    };
    await expect(checkCompatibility(session, () => current)).rejects.toThrow(
      "wrong-account",
    );
    expect(signatures).toBe(1);
  });
});
