import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("Foundation", (m) => {
  const schemaVersion = m.getParameter("schemaVersion", 1);
  const probe = m.contract("FoundationProbe", [schemaVersion]);
  const testToken = m.contract("TestPaymentToken", [m.getAccount(0)]);
  return { probe, testToken };
});
