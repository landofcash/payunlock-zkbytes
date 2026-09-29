import { configVariable, defineConfig } from "hardhat/config";
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";

const compiler = { version: "0.8.37", isolated: true, settings: { evmVersion: "osaka", viaIR: true, optimizer: { enabled: true, runs: 1 } } };

export default defineConfig({
  plugins: [hardhatToolboxMochaEthers],
  solidity: { profiles: { default: compiler, production: compiler } },
  networks: {
    hardhatMainnet: { type: "edr-simulated", chainType: "l1", chainId: 31337 },
    monadTestnet: { type: "http", chainType: "l1", chainId: 10143, url: configVariable("MONAD_TESTNET_RPC_URL"), accounts: [configVariable("MONAD_TESTNET_DEPLOYER_KEY")] },
    monadMainnet: { type: "http", chainType: "l1", chainId: 143, url: configVariable("MONAD_MAINNET_RPC_URL"), accounts: [configVariable("MONAD_MAINNET_DEPLOYER_KEY")] },
  },
});
