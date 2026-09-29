# Passkey account recovery

Create Account prefers a passkey when WebAuthn is available in a secure browser.
The selected authenticator must return PRF output; browser API availability alone
does not prove that the provider supports PRF. The creation dialog always offers
Use password instead. Cancellation and unsupported PRF never silently create a
different wallet. A failed ceremony can leave an unused passkey at the provider.

Sign in with passkey discovers an existing credential without requiring local
storage or IndexedDB. It reconstructs the wallet and starts the same five-minute
Mera session used by password wallets. Private key/PRF bytes are not persisted.
The existing scoped delivery authorization and receiving-key derivation remain
in use. Submitted order contexts and delivery references provide the public
inputs needed to restore delivery access; unsent page-only drafts are not part
of account recovery.

Previously used passkey accounts appear in Your accounts with a Passkey label.
Only the public address, credential ID and relying party ID are cached in
`payunlock.passkey-accounts.v1` in localStorage. The row's Sign in action selects
that credential and verifies the reconstructed address. Missing, corrupt or
unavailable storage never prevents general Sign in with passkey from discovering
an account again. Clearing storage removes the list hints, not the passkey.

## Permanent recovery profile v1

- Relying party ID: the app hostname at creation. Use a stable HTTPS hostname
  for the demo and production. Local development should use `localhost`;
  an IP address may be rejected by WebAuthn. A passkey from localhost will not
  recover the account on the production domain.
- PRF salt: Mera's default `SHA-256("mera.prf.salt.v1")`, identical for creation
  and sign-in. It is public and supplied by the pinned Mera implementation.
- Entropy: all 32 bytes of PRF output.
- Derivation: BIP-39 English, empty BIP-39 passphrase, BIP-32 path
  `m/44'/60'/0'/0/0`, implemented with the existing ethers dependency.

Do not rotate these values or change derivation defaults: doing so produces a
different wallet. No per-user random salt or local credential record is required.
Creating another passkey creates another wallet; recovery always uses Sign in.

## Password fallback and recovery exports

Password-created and imported wallets retain their existing Argon2id/AES-GCM
local vault. They require the recovery phrase or private key on a fresh device.
There is no automatic conversion of existing wallets into passkey-derived ones.

Back up account on a passkey session requires a new assertion restricted to its
credential. The resulting address is checked before exposing recovery material.
The exported 24-word phrase or private key can be imported into the password
wallet flow and preserves the address and delivery access. Exported secrets
must be protected like any other wallet backup. The UI hides them after one
minute and clears them on session changes/page exit.

## Acceptance checks

Automated tests cover deterministic identity and receiving-key reconstruction
without browser storage, phrase/key import compatibility, wrong-credential export
rejection, PRF byte clearing, session expiry, and UI fallback/cancellation.
These tests simulate authenticator output; they do not prove provider sync.

A Chromium browser check with a virtual PRF-capable authenticator also passed:
create account, clear browser storage and cookies, reload with zero saved
accounts, and sign in to recover the identical address. The backend was offline,
so this browser check did not exercise live order retrieval or decryption.

Before the hackathon, on the final HTTPS hostname:

1. Create a passkey account with a PRF-capable provider. Record its public address.
2. Complete a purchase and encrypted delivery; confirm the buyer can decrypt it.
3. Clear localStorage, sessionStorage, IndexedDB, cookies and reload. Sign in with
   the existing passkey and confirm the same address, orders and decryption.
4. Repeat on a fresh device using that same synced passkey or supported
   cross-device authentication. Do not create a replacement passkey.
5. Export recovery material, import on an unsupported device, and confirm the
   same address and decryption. Test both phrase and private-key imports.
6. Check cancellation and a provider without PRF support. Verify that password
   creation requires an explicit choice and never claims to recover a passkey.
7. Run reviewed delivery signing, wait for session expiry, and sign in again.

Actual cross-device/provider validation remains a manual acceptance check.
