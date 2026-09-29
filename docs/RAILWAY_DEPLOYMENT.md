# Railway deployment

Project: `payunlock.zkbytes.com`. Production follows `landofcash/payunlock-zkbytes` on `main`.

First release verified on 2026-09-29: `https://payunlock.zkbytes.com` and
`https://api.payunlock.zkbytes.com` have valid Railway certificates. The API
serves `/ready` and lists zkbytes storage service 1 for new offers.

| Service | Source / image | Port | Health check |
| --- | --- | ---: | --- |
| `payunlock-zkbytes` | `Dockerfile.frontend` | 3000 | `/` |
| `payunlock-api` | `Dockerfile.backend` | 8080 | `/ready` |
| `payunlock-relayer` | `Dockerfile.backend`, `pnpm --filter @payunlock/backend start:worker` | none | none |
| `payunlock-indexer` | `payunlock-indexer/Dockerfile` | 9898, private | `/healthz` |
| `payunlock-hasura` | `hasura/graphql-engine:v2.48.0` | 8080, private | `/healthz` |
| `Postgres` | Railway PostgreSQL template | private | Railway managed |
| Indexer Postgres | Separate Railway PostgreSQL template | private | Railway managed |

The frontend image bakes `VITE_API_ORIGIN`, `VITE_CHAIN_ID`, `VITE_WALLETS_ENABLED`, and `VITE_REOWN_PROJECT_ID` at build time. Changing one requires a new frontend build. Caddy serves the built files and falls back to `index.html` for browser routes. The API runs forward-only migrations in Railway's pre-deploy step, then starts Fastify on `0.0.0.0:8080`. Its `/ready` check verifies database readiness. Each GitHub service must track `main` without a pinned commit. Enable **Wait for CI** on each GitHub service in Railway once its GitHub Actions checks appear.

## Required configuration

- Frontend: `VITE_API_ORIGIN=https://api.payunlock.zkbytes.com`, `VITE_CHAIN_ID=10143`, `VITE_WALLETS_ENABLED=true`, and a Reown project ID authorized for `payunlock.zkbytes.com`.
- API: `DATABASE_URL` references the app Postgres service. Set `API_HOST=0.0.0.0`, `API_PORT=8080`, `API_ORIGINS=https://payunlock.zkbytes.com`, `PAYUNLOCK_DEPLOYMENT_VERSION=v5`, the Monad testnet RPC/chain/allowed payment assets, and the zkbytes API and download origins. Its Envio GraphQL URL points to private Hasura and its admin secret references Hasura's variable.
- Indexer: `ENVIO_API_TOKEN` for HyperSync, the indexer Postgres connection variables, and the private Hasura metadata endpoint and admin secret. Hasura uses the indexer Postgres URL, with its own generated admin secret. Neither Hasura nor Postgres needs a public domain.
- Relayer: the API's chain, database, storage and indexer settings plus `RELAYER_PRIVATE_KEY`, `RELAYER_DAILY_BUDGET_WEI`, and `RELAYER_MAX_FEE_PER_GAS_WEI`. The key must be separately funded for the intended testnet budget; never put it in Git or a `VITE_` variable. Do not deploy the relayer until these are set.
- Confirm the live zkbytes retention limit before advertising storage service 1 in PayUnlock. Set `ZKBYTES_MAX_RETENTION_SECONDS` to that value, then enable `ZKBYTES_OFFER_NEW` when the configured service is ready. The configured Pull Zone must allow `https://payunlock.zkbytes.com`; add that exact origin to the existing zkbytes API CORS list without removing its other origins.

## First release

1. Push the deployment files to `main` and let GitHub Actions pass. Inspect the staged Railway changes before applying them.
2. Apply the staged services after their required variables are set. Follow each exact deployment to `SUCCESS`; check API `/ready`, indexer `/healthz`, frontend `/`, and a deep link such as `/products/example` for the SPA fallback. Check the indexer reports current V5 progress before accepting order-history behavior.
3. Attach `payunlock.zkbytes.com` to the frontend and `api.payunlock.zkbytes.com` to the API. Add the DNS records Railway provides and wait for certificate verification. Verify both public HTTPS origins and browser CORS.
4. In Reown, allow `payunlock.zkbytes.com`. Complete a real testnet wallet, catalog, checkout, order-history, and sponsored-action smoke check. Keep the relayer funded within its configured budget.

Subsequent `main` commits should start a deployment for each GitHub-backed service. CI failures should hold the deployment when **Wait for CI** is enabled.
