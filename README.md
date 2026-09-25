# PayUnlock

A hackathon project for selling digital products and event access with encrypted delivery on Monad.

## Demo status

The current preview supports MetaMask, WalletConnect, and a built-in wallet. All three wallet options have been manually tested successfully.

Live checks have verified:

- Connectivity to Monad Testnet through Alchemy.
- Encrypted content storage through zkbytes with one-year retention.
- Buyer and seller access recovery and decryption.
- Browser upload, recovery, and downloads from both local app addresses.

Automated tests, build, type checks, and lint pass. Purchases, escrow settlement, and the full sales experience are still in development; the preview does not accept payments.

## Run the preview

Requires Node **24.11.0**, pnpm **11.27.0**, and Docker with Linux containers running.

```sh
pnpm install --frozen-lockfile
pnpm env:init
pnpm db:start
pnpm db:migrate
pnpm dev
```

Open **http://127.0.0.1:4320/wallet**.

Configure local service settings in `.env` using `.env.example`. Keep `VITE_WALLETS_ENABLED=true` to enable the wallet screen; WalletConnect also requires `VITE_REOWN_PROJECT_ID`. Restart the app after changing settings. Existing `.env` files are preserved by setup.

Use test wallets for the demo. Keep credentials in the ignored `.env` file; `VITE_` values are public browser configuration. Save your built-in wallet recovery phrase or private key: the local unlock passphrase alone cannot restore a lost wallet.
