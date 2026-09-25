import { expect } from "chai";
import { network } from "hardhat";
import Foundation from "../ignition/modules/Foundation.js";

describe("Foundation toolchain", function () {
  it("deploys and initializes through Ignition on an isolated local EVM", async function () {
    const connection = await network.create();
    try {
      const { probe, testToken } = await connection.ignition.deploy(Foundation);
      expect(await probe.getFunction("schemaVersion")()).to.equal(1n);
      expect(await testToken.getFunction("decimals")()).to.equal(6n);
    } finally { await connection.close(); }
  });
  it("uses isolated deterministic accounts and exact token units", async function () {
    const connection = await network.create();
    try {
      const [seller, buyer] = await connection.ethers.getSigners();
      if (!seller || !buyer) throw new Error("Expected two local test accounts");
      const token = await connection.ethers.deployContract("TestPaymentToken", [seller.address]);
      await expect(token.getFunction("transfer")(buyer.address, 3_000_000n)).to.changeTokenBalances(connection.ethers, token, [seller, buyer], [-3_000_000n, 3_000_000n]);
      expect(await token.getFunction("balanceOf")(buyer.address)).to.equal(3_000_000n);
      await expect(connection.ethers.deployContract("FoundationProbe", [0n])).to.be.revertedWith("version required");
    } finally { await connection.close(); }
  });
});
