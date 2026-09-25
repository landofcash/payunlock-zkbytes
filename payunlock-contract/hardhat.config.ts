import { configVariable, defineConfig } from "hardhat/config";
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";

export default defineConfig({
  plugins: [hardhatToolboxMochaEthers],
  solidity: { version: "0.8.37", settings: { evmVersion: "osaka", optimizer: { enabled: true, runs: 200 } } },
  networks: {
    hardhatMainnet: { type: "edr-simulated", chainType: "l1", chainId: 31337 },
    monadTestnet: { type: "http", chainType: "l1", chainId: 10143, url: configVariable("MONAD_TESTNET_RPC_URL"), accounts: [configVariable("MONAD_TESTNET_DEPLOYER_KEY")] },
    monadMainnet: { type: "http", chainType: "l1", chainId: 143, url: configVariable("MONAD_MAINNET_RPC_URL"), accounts: [configVariable("MONAD_MAINNET_DEPLOYER_KEY")] },
  },
});
