# PayUnlock

A hackathon project for selling digital products and event access with encrypted delivery on Monad.

Known issues, deployment blockers, and deferred MVP improvements are tracked in [the issue tracker](docs/ISSUE_TRACKER.md).

## Demo status

The current preview supports MetaMask, WalletConnect, and a built-in wallet. All three wallet options have been manually tested successfully.

Live checks have verified:

- Connectivity to Monad Testnet through Alchemy.
- Encrypted content storage through zkbytes with one-year retention.
- Buyer and seller access recovery and decryption.
- Browser upload, recovery, and downloads from both local app addresses.

The V5 escrow and authorization router are deployed on Monad Testnet with Circle USDC enabled. Creators can prepare and publish offers, edit future purchase terms, and pause sales. Buyers can review and pay with test MON or approved tokens, recover pending purchases, and claim eligible refunds. A zero-MON buyer completed a sponsored Circle USDC purchase and a second purchase through an independent relayer; V5 explorer source verification is pending.

Sellers can now fulfill orders with encrypted text. Buyers can open deliveries, accept them, or start a private dispute. The preview also supports arbitration, evidence review, refunds, and seller payouts.

Earlier V4 live Monad Testnet checks passed for delivery, both-party access recovery, acceptance, payouts, refunds, private negotiation, and arbitrator replacement. A complete V4 browser delivery-to-payout flow also passed with two test wallets; these results do not yet establish V5 end-to-end acceptance.

Order history now synchronizes with the deployed contracts. Tests also verify wallet sign-in, seller-only catalog editing, purchase recovery, and recovery from a changed blockchain history.

The homepage's Top Offers are selected by the platform administrator (the current escrow contract owner). On an offer's details page, sign in with that wallet to add or remove it from featured offers, or restrict its presentation. Use **Platform administration → Manage featured offers** (`/admin/featured`) to move selected offers up or down, remove them, and save the list. Only public, unrestricted offers appear on the homepage; Discover lists the other public, unrestricted offers.

Restricted offers remain accessible through direct links and existing orders, with placeholder text and image URLs. Checkout, fulfillment, refunds, and arbitration retain their existing rules. Original metadata and images are preserved, and original direct image URLs remain accessible. Restricting an offer removes its featured selection; removing the restriction does not automatically feature it again. Run `pnpm db:migrate` before starting the updated API.

Administrators can review original restricted content through **Restricted Offers** in the wallet menu (`/admin/restricted`). Cards open `/admin/offers/:id`, showing original images and text, current sale terms when available, and a Remove restriction action. The regular masked offer page also includes an admin-only View original details link. Original metadata endpoints require the authenticated current contract owner; images use their existing public URLs.

## Run the preview

Requires Node **24.11.0**, pnpm **11.27.0**, and Docker with Linux containers running.

```sh
pnpm install --frozen-lockfile
pnpm env:init
pnpm db:start
pnpm db:migrate
pnpm dev
```

For sponsored V5 actions, start the separate funded relayer worker with `pnpm dev:worker`. The on-chain router accepts valid authorizations from any relayer; the project's worker is an optional convenience. The local V5 indexer starts with `pnpm indexer:start` after `pnpm indexer:build`.

Open **http://127.0.0.1:4320/** and connect a wallet to create offers or buy.

For local passkey testing, use **http://localhost:4320/** instead (start the frontend with `pnpm --filter @payunlock/frontend dev --host localhost` if needed). Passkeys are bound to the hostname where they were created.

Configure local service settings in `.env` using `.env.example`. Keep `VITE_WALLETS_ENABLED=true` to enable the wallet screen; WalletConnect also requires `VITE_REOWN_PROJECT_ID`. Restart the app after changing settings. Existing `.env` files are preserved by setup.

Use test wallets for the demo. Keep credentials in the ignored `.env` file; `VITE_` values are public browser configuration. Create Account now prefers passkeys on supported devices, with password creation and phrase/private-key imports retained. Sign in with the same passkey to recover a passkey account; export a recovery backup for devices without PRF support. Password wallets still require their recovery phrase or private key after local storage is lost. See [passkey recovery and acceptance checks](docs/PASSKEY_RECOVERY.md).
