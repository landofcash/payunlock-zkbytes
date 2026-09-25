# PayUnlock

Digital product sales and event access with EVM escrow and zkbytes encrypted delivery.

Phase 2 adds the local/external wallet layer and tested encrypted-delivery/recovery protocol. The application remains a non-payable preview: catalog, deployed escrow, commerce screens and indexing are subsequent phases. See [Phase 2 evidence and remaining live checks](docs/phase-2-validation.md).

## First run

Use Node **24.11.0** (see `.node-version`), **pnpm 11.27.0**, and Docker with Linux containers. This workspace is self-contained; sibling repositories are not install dependencies.

```sh
pnpm install --frozen-lockfile
pnpm env:init
pnpm db:start
pnpm db:migrate
pnpm dev
```

`pnpm env:init` creates an ignored root `.env` with a random local database password and preserves an existing file. The tracked `.env.example` contains public settings/placeholders. Never put secrets in `VITE_` variables: Vite exposes them to the browser. Frontend environment changes require restarting/rebuilding.

| Process | Address |
| --- | --- |
| Frontend | http://127.0.0.1:4320 |
| API liveness | http://127.0.0.1:4321/health |
| API/database readiness | http://127.0.0.1:4321/ready |
| PostgreSQL | 127.0.0.1:5434 |

The PostgreSQL Compose project is `payunlock`, with its own `payunlock_postgres-data` volume. `pnpm db:stop` preserves data. API startup never applies migrations. To change the database port, update both `POSTGRES_PORT` and `DATABASE_URL` before starting. Changing `.env` credentials does not rotate credentials in an existing database volume.

## Checks and operation

```sh
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm test:db          # running, migrated PayUnlock database required
pnpm rpc:check        # read-only Monad Testnet chain/finalized-block check
pnpm rpc:check:alchemy # same check, requires a provisioned Alchemy Testnet URL
pnpm dev:worker       # configuration preflight; exits, no indexing yet
pnpm contract:deploy:local
```

Contract tests create temporary local EVM connections with deterministic accounts and a six-decimal `TESTUSD` token. No persistent local chain or public wallet key is needed. Never use deterministic test accounts on public networks.

For a compiled API, run `pnpm build`, explicitly run `pnpm db:migrate:prod`, then `pnpm --filter @payunlock/backend start`. Retain `payunlock-backend/migrations/` with the backend build. Set `API_HOST=0.0.0.0` only when intentionally exposing the API. Hosting is not selected yet.

## Network and deployment

App integration targets **Monad Testnet (10143)** using test MON. Obtain test funds for a separate development wallet from the [Monad faucet](https://faucet.monad.xyz). Installation, tests, and app startup do not deploy public contracts. The RPC check sends no transaction.

The **Alchemy RPC** trial has passed live read-only chain/finalized-block checks; contract operations follow in Phase 3. **Envio HyperIndex** remains a Phase 4 trial and the worker is still a stub. See the [service boundaries and documentation availability](docs/architecture.md#approved-service-trials-not-yet-integrated). Application PostgreSQL retains catalog/private metadata; Envio will provide derived blockchain history through the API if its acceptance checks pass.

Set `VITE_WALLETS_ENABLED=true` to enable `/wallet`. MetaMask and the built-in wallet do not require a Reown ID; WalletConnect does. New `.env` files enable the wallet screen; existing files are preserved by setup. Back up the built-in wallet recovery phrase/private key: its local passphrase alone cannot recover a lost wallet. Delivery protocol and protected journal details are in [protocol v1](docs/delivery-protocol-v1.md).

See [contract setup](payunlock-contract/README.md) for Ignition, ABI exports, deployment identities, and journal retention. Mainnet remains a later release step; the Phase 1 test module is not escrow.

The [architecture note](docs/architecture.md) records confirmed boundaries and reuse sources; [validation evidence](docs/phase-1-validation.md) records checks and limits. Shared HTTP schemas live in `packages/api-contracts/`. Detailed plans remain ignored in `doc/local/`; build-critical instructions are tracked.

- `payunlock-frontend/` — buyer and seller application
- `payunlock-backend/` — API, PostgreSQL, and chain synchronization
- `payunlock-contract/` — product configuration and order escrow
