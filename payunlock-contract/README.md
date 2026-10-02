# Contract foundation

PayUnlock supports V5 only. The application uses the current escrow ABI and `deployments/monad-testnet-payunlock-v5.json`; V1–V4 deployments and their compatibility paths have been removed.

From the repository root:

```sh
pnpm contract:build
pnpm contract:test
pnpm contract:deploy:local
```

The local command deploys the V5 escrow and authorization router with a mock USDC receive-authorization token on a temporary EVM. It does not start a persistent node or provide public-network application addresses. Tests use independent temporary connections.

## Ignition and public networks

`ignition/modules/PayUnlock.ts` defines V5 initialization. Local parameters are in `ignition/parameters/payunlock-local.json`; `scripts/local.ts` supplies the locally deployed mock token. The testnet script supplies the verified Circle testnet USDC address.

For an intentional testnet deployment, configure `MONAD_TESTNET_RPC_URL` and `MONAD_TESTNET_DEPLOYER_KEY` locally. The testnet package commands load the ignored root `.env`. Hardhat also supports its keystore; from `payunlock-contract/`:

```sh
pnpm exec hardhat keystore set MONAD_TESTNET_RPC_URL
pnpm exec hardhat keystore set MONAD_TESTNET_DEPLOYER_KEY
```

`pnpm contract:preflight:testnet` checks the configured deployer and network. `pnpm contract:deploy:testnet` deploys or resumes V5 with that funded test wallet. `pnpm contract:check:testnet` verifies the finalized deployment and configuration.

Retain `ignition/deployments/monad-testnet-payunlock-v5/` with the release, including journal/build info/addresses. Resume the same module, parameters, network, and ID after interruption. Never delete the active journal to force redeployment. Never include private keys/private RPC credentials in records.

Update `deployments/monad-testnet-payunlock-v5.json` from confirmed evidence only. Mainnet deployment remains disabled pending separate review and verified payment assets.

## ABI ownership

`pnpm contract:build` exports the current PayUnlock, codec, and authorization-router ABIs to tracked `abi/`. Consumers use these ABIs. Full artifacts and ethers types regenerate; CI checks tracked ABI drift.

Explicit `osaka` follows the Monad guide. Local tests do not prove deployed Monad behavior, gas, or finality. Public-network acceptance is recorded separately.
