# Contract foundation

Phase 1 proves compilation, OpenZeppelin imports, local EVM testing, initialization, and ABI export. `FoundationProbe` is not escrow. `TestPaymentToken` is PayUnlock Test USD (`TESTUSD`, six decimals), deployable only on local chain 31337 or Monad Testnet 10143. It is not USDC.

From the repository root:

```sh
pnpm contract:build
pnpm contract:test
pnpm contract:deploy:local
```

The local command uses a temporary EVM and `local-foundation`; it does not start a persistent node or provide application addresses. Tests use independent temporary connections.

## Ignition and public networks

`ignition/modules/Foundation.ts` defines constructor initialization. Parameters are in `ignition/parameters/`. The empty mainnet parameters reserve configuration space, not a deployable escrow. Environments have separate config variables/deployment IDs.

For an intentional later **test scaffold** deployment, configure `MONAD_TESTNET_RPC_URL` and `MONAD_TESTNET_DEPLOYER_KEY` using Hardhat keystore or process environment. Hardhat does not load root `.env`; deployment secrets stay separate. From `payunlock-contract/`:

```sh
pnpm exec hardhat keystore set MONAD_TESTNET_RPC_URL
pnpm exec hardhat keystore set MONAD_TESTNET_DEPLOYER_KEY
```

Then `pnpm contract:deploy:testnet` from the root uses a dedicated funded test wallet. No public deployment is required by Phase 1; actual escrow belongs to Phase 3.

Retain `ignition/deployments/monad-testnet-foundation-v1/` with the release, including journal/build info/addresses. Resume the same module, parameters, network, and ID after interruption. Never delete journals to force redeployment or pretend to upgrade a contract. Never include private keys/private RPC credentials in records.

Update `deployments/monad-testnet.json` from confirmed evidence only: addresses, deployment block, ABI/revision identity, configuration authority, and token decimals. Null means not deployed. Mainnet reserves `monad-mainnet-escrow-v1`, with separately verified assets after acceptance.

## ABI ownership

`pnpm contract:build` exports `{ contractName, abi }` JSON to tracked `abi/`. Consumers import `@payunlock/contract/abi/FoundationProbe` (or the future escrow), not hand-copied fragments. Full artifacts/ethers types regenerate; CI checks tracked ABI drift.

Explicit `osaka` follows the Monad guide. Local tests do not prove deployed Monad behavior, gas, finality, or escrow correctness. Guard/admin/upgrade policy remains a Phase 3 decision.
