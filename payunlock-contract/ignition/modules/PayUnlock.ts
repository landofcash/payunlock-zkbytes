import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("PayUnlockV5", (m) => {
  const admin = m.getParameter<string>("admin");
  const defaultReviewWindow = m.getParameter<number>("defaultReviewWindow");
  const minResponseWindow = m.getParameter<number>("minResponseWindow");
  const minCommitmentWindow = m.getParameter<number>("minCommitmentWindow");
  const maxCommitmentWindow = m.getParameter<number>("maxCommitmentWindow");
  const usdc = m.getParameter<string>("usdc");
  const codec = m.library("PayUnlockCodec");
  const arbitration = m.library("PayUnlockArbitration", { libraries: { PayUnlockCodec: codec } });
  const transfers = m.library("PayUnlockTransfers");
  const escrow = m.contract("PayUnlock", [admin, defaultReviewWindow, minResponseWindow, minCommitmentWindow, maxCommitmentWindow], {
    libraries: { PayUnlockCodec: codec, PayUnlockArbitration: arbitration, PayUnlockTransfers: transfers },
  });
  const router = m.contract("PayUnlockAuthorizationRouter", [escrow]);
  const sender = { from: m.getAccount(0) };
  m.call(escrow, "setAuthorizationRouter", [router], sender);
  const allowUsdc = m.call(escrow, "setAllowedAsset", [usdc, true], sender);
  m.call(escrow, "setReceiveAuthorizationAsset", [usdc, true], { ...sender, after: [allowUsdc] });
  m.call(escrow, "setArbitrationFeeAsset", [usdc], { ...sender, after: [allowUsdc] });
  return { codec, arbitration, transfers, escrow, router };
});
