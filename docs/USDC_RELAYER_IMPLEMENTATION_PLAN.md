# Supported-token payments and permissionless relaying

Date: 2026-09-28

Status: V5 implementation and local testnet cutover in progress. The V5 escrow and router are deployed and finalized on Monad Testnet. The dedicated PayUnlock development database was reset and migrated, and the indexer was moved to a fresh V5 database volume and reached realtime indexing. Circle USDC is enabled. A funded zero-MON buyer completed one sponsored USDC purchase through the project relayer and a second purchase through an independent EOA; complete browser acceptance remains outstanding. See [V5 testnet cutover evidence](V5_TESTNET_CUTOVER.md).

## 1. Outcome and confirmed requirements

- Support admin-enabled payment tokens, with Circle USDC as the initial integration/example rather than a hardcoded asset restriction. Remove PayUnlock TESTUSD from deployment, offer creation, and ordinary application flows.
- Once signed in with the receiving encryption key available, sponsored checkout requires **one wallet signature and one on-chain transaction**. The buyer needs USDC but no MON.
- PayUnlock operates an optional relayer that pays network fees. A relayer is an off-chain transaction sender, not the escrow contract and not the owner of customer funds.
- Any account may relay a valid authorization. Contract execution must not require a first-party relayer address, API approval, or sponsorship service.
- Users may explicitly choose direct submission and pay MON when sponsorship is unavailable or unwanted. Show the gas estimate and obtain transaction approval; never silently switch to a user-paid transaction.
- Extend sponsorship to buyer, seller, and arbitrator actions. Preserve the current escrow lifecycle, encrypted delivery, participant identities, and dispute rights.
- Add an admin-configurable percentage service fee deducted from the order proceeds at final settlement. Recommended interpretation: charge on seller payout only; refund the full purchase principal when the buyer wins or receives a refund.
- Add an admin-configurable offer placement fee denominated in MON. Proposed payer/trigger: seller, once per successful first on-chain offer creation; draft saves, edits, and pause/resume are not new placements.
- MON payments are direct and user-funded, including their network gas. Do not sponsor MON purchases or MON offer placement, and do not implement prepaid MON credits. Sponsorship covers USDC payments and eligible actions that do not require the submitter to attach a native payment.
- The arbitrator sets their own arbitration fee in **USDC** (currency confirmed on 2026-09-28). The party initiating arbitration pays it, separately from the order principal and platform service fee. Network gas may still be sponsored.
- Deploy a new immutable escrow while the project is in development. The user explicitly authorized resetting PayUnlock's development database and discarding current orders on 2026-09-28. No legacy-order application support or data migration is required for this cutover. Old on-chain contracts and funds cannot be erased by a database reset.

These requirements supersede the earlier ordinary-ERC-20-only checkout and admin-controlled MON arbitrator pricing designs for the new deployment. They authorize a clean PayUnlock development-data reset and fresh testnet deployment during implementation, not a mainnet deployment, reset of other projects/databases, or conversion/movement of existing on-chain assets. Detailed fee policies below are recommendations where the user has not specified the rule.

The one-interaction target assumes sign-in, wallet unlock, and encryption-key preparation have already happened. External-wallet setup, an expired signature, or a changed offer can require a new confirmation. Direct submission has a different confirmation count, described below.

## 2. Current implementation and affected boundaries

| Area | Current behavior | Required change |
| --- | --- | --- |
| [PayUnlock.sol](../payunlock-contract/contracts/PayUnlock.sol) | `purchase` uses `msg.sender` as buyer and `safeTransferFrom` for ERC-20 payment; lifecycle authorization and record authors also use `msg.sender` | Explicit verified actor in shared internal action logic; USDC authorized purchase; permissionless signed lifecycle actions |
| [Deployment module](../payunlock-contract/ignition/modules/PayUnlock.ts) | Deploys and enables `TestPaymentToken` | Configure the official chain-specific USDC address; do not deploy TESTUSD |
| [Transaction service](../payunlock-backend/src/services/transaction-service.ts) | Prepares separate approval and purchase; checks buyer MON; raw broadcast requires buyer as transaction sender | Separate authorizing actor, gas payer, signed request, and outer transaction |
| [Chain service](../payunlock-backend/src/services/chain-service.ts) | Loads the v4 deployment; receipt ownership assumes `receipt.from === wallet` | Fresh deployment configuration and verification using decoded authorization, escrow events, and resulting state |
| [Commerce routes](../payunlock-backend/src/routes/commerce.ts) | Batch status also checks transaction sender and direct calldata | Support authorized envelopes while retaining exact action matching |
| [Wallet types](../payunlock-frontend/src/wallet/types.ts) | Message and transaction signing; no typed-data interface | Add bounded EIP-712 signing for built-in, MetaMask, and WalletConnect adapters |
| [Checkout](../payunlock-frontend/src/commerce/ProductPage.tsx) and [transaction UI](../payunlock-frontend/src/commerce/ui.tsx) | Approval/payment reviews and user gas checks | Sponsored default, explicit direct fallback, shared confirmation/recovery UI |
| [Purchase journal](../payunlock-frontend/src/commerce/purchase-journal.ts), bulk and lifecycle journals | Recovery centered on user transactions; purchase journal intentionally excludes signatures | Track stable operation identity independently of sender and transaction hash |
| [Indexer](../payunlock-indexer/config.yaml) | Contract events project products, orders, and authors | New deployment/ABI; actor-based event handling and authorization execution receipts |
| [Worker](../payunlock-backend/src/worker.ts) | Explicitly states that no polling worker is needed | Add a dedicated relayer worker; Envio remains responsible for chain indexing |
| Settlement / placement / arbitrator configuration in `PayUnlock.sol` | `_settle` transfers the entire principal; `createProduct` is nonpayable; owner-only `configureArbitrator` sets price | Split seller proceeds and platform fee; charge MON placement; separate admin eligibility from arbitrator pricing |
| [PayUnlockTypes.sol](../payunlock-contract/contracts/PayUnlockTypes.sol), [codec](../payunlock-contract/contracts/PayUnlockCodec.sol), [backend domain](../payunlock-backend/src/domain.ts) | Order and assignment layouts lack platform fee snapshots and explicit arbitration fee asset | Versioned fee snapshots, hashing/serialization, API and indexer updates |

Source was inspected for this plan. Live read-only USDC authorization checks on both Monad networks passed on 2026-09-28; see section 3.3 for evidence and limits. PayUnlock's enabled-asset configuration was not read live. A frontend icon alone is not evidence of token capability or escrow enablement.

## 3. Design: one-signature authorized token purchase

Use a verified token's EIP-3009 **`receiveWithAuthorization`** for sponsored purchases. Circle USDC is the first verified example. Unless explicitly discussing the USDC deployment or test evidence, references to USDC below illustrate the generic supported-token route. Do not add a separate PayUnlock purchase signature: that would miss the one-interaction requirement.

Keep two separate on-chain configuration concepts: whether an asset is allowed for new payments, and its explicitly enabled authorization mode. Initial modes are `direct-only` and `eip3009-receive`. Bind the selected token address and authorization mode/version to reviewed execution; the relayer cannot substitute either. Do not infer support from a token symbol, logo, selector scan, or admin allowlisting alone.

- An enabled ordinary ERC-20 can use direct approval/purchase even without signed-transfer support.
- An enabled, verified EIP-3009 receive token can use the one-signature sponsored route.
- EIP-2612 `permit` alone does not establish compatibility with this single-signature order-bound design: its nonce is sequential and its message does not bind the purchase parameters. A different mechanism needs its own reviewed implementation and tests; do not silently fall back to an extra signature or weaker authorization.
- Native MON retains direct-only payment behavior. MON is not an ERC-20 authorization token.

Token profiles are keyed by chain ID and exact token/proxy address and include decimals, EIP-712 domain, supported ABI overloads, cancellation support, and verification evidence. Revalidate after proxy upgrades. The escrow should perform only known interface calls to explicitly configured assets, never delegatecall user-supplied adapters. Fee-on-transfer/rebasing behavior is incompatible with the current exact-transfer accounting unless separately designed and tested. Refunds and service fees always use the order's recorded token.

Proposed flow:

1. The client resolves the offer, current expected terms, receiving public key/context, buyer, exact USDC amount, stable purchase request ID, authorization validity window, and a random salt.
2. The client locally constructs and verifies the authorization described below. It does not blindly sign a backend-supplied typed-data object.
3. The buyer signs one USDC `ReceiveWithAuthorization` EIP-712 message.
4. The client submits a complete execution packet to a relayer of its choice.
5. The relayer simulates and submits `purchaseWithAuthorization(...)`, paying MON.
6. PayUnlock validates the purchase commitment, assigns the signed buyer as actor, calls USDC `receiveWithAuthorization` into escrow, verifies the received amount, and records the order atomically.
7. The application confirms the actual purchase using canonical finalized chain state, not a relayer acknowledgement.

If order validation or token transfer fails, the entire transaction reverts, including token movement, authorization consumption, and order creation. The relayer may still incur a network fee for a reverted transaction; that cost is not charged to the buyer implicitly.

### 3.1 Bind the signature to the complete order

USDC's authorization signs `from`, `to`, `value`, `validAfter`, `validBefore`, and `nonce`. It does **not** directly sign an offer ID or receiving public key. A naive wrapper would let a relayer substitute a different same-price offer or receiving key.

Use the signed 32-byte authorization nonce as a commitment to the complete purchase intent. Proposed versioned encoding:

```text
intentHash = keccak256(abi.encode(
  PURCHASE_INTENT_V1_TYPEHASH,
  chainId, escrowAddress, tokenAddress, authorizationModeVersion,
  buyer, seller, productKey, requestId, expectedTerms,
  buyerReceiving.nonce, buyerReceiving.publicKey,
  amount, validAfter, validBefore, salt
))

Selected token's ReceiveWithAuthorization (USDC example):
  from        = buyer
  to          = escrowAddress
  value       = amount
  validAfter  = reviewed validAfter
  validBefore = reviewed validBefore
  nonce       = intentHash
```

Freeze Solidity types, field order, type hash, and domain version in shared fixtures before implementation. Use `abi.encode`, not ambiguous concatenation. A cryptographically random salt makes otherwise identical authorizations unique; the purchase request ID remains stable across retries of the same intended purchase.

The escrow recomputes the commitment from the submitted intent and requires equality with the signed token authorization nonce. It also verifies the current checkout hash, exact order token address, allowed asset and enabled authorization mode/version, exact price, buyer, seller, and receiving context. The new checkout hash includes the service-fee rate and recipient to be snapshotted, so changes require a fresh reviewed authorization. The product's seller-approved fee cap also constrains purchases. Changing any committed field invalidates execution. The selected token validates its signature, domain, validity window, and replay protection.

Use **ReceiveWithAuthorization**, not TransferWithAuthorization: the former restricts consumption to the recipient contract, preventing someone from submitting the token authorization directly to USDC and depositing funds without creating the order. Reject native value on this purchase path. PayUnlock must not expose an alternative function that can consume a purchase authorization without its order-binding checks.

A standard wallet may display the USDC amount, recipient, expiry, and opaque nonce rather than the offer details. PayUnlock must display and locally verify the human-readable order before signing; do not claim the wallet independently decodes the order commitment.

Keep `orderForRequest[buyer][requestId]` as a second, independent duplicate-payment guard. A re-signed authorization with a new expiry or salt cannot create another order with the same buyer/request ID. A new request ID is generated only for a deliberate new purchase.

For a pending USDC authorization, support the token's verified `cancelAuthorization` mechanism through a separate cancellation signature and permissionless submission, or a direct cancellation transaction if its interface supports that form. Cancellation is a separate user action and can race execution; report it as complete only after canonical confirmation. Canceling a local/relayer job does not revoke an exported signature. Lifecycle nonces described below and USDC authorization nonces are separate domains and require separate cancellation handling.

### 3.2 Token and wallet capability gate

- Initial USDC capability/domain checks are complete as recorded below. Recheck the exact deployment before cutover and apply the same verification procedure to every additional sponsored token.
- Verify each deployed EIP-712 domain and the authorization-state/cancellation interfaces. Do not assume a token name/version from a symbol or from another network.
- Test the actual implementation on a fork with signed authorization and atomic wrapper execution; complete a real testnet acceptance purchase after deployment.
- This network uses Circle's **testnet USDC**, not financially backed mainnet USDC. Mainnet has separate addresses, deployment records, and acceptance gates.
- If the target lacks the required interface, report that before committing to this design. Do not silently substitute permit plus a second user signature, unlimited allowance, another token, or a smart-account migration.
- Existing EOA-backed built-in/passkey wallets remain EOAs. Supporting smart-contract wallets end-to-end is a separate capability check across USDC signature verification, app sign-in, receiving-key derivation, and lifecycle signatures.

### 3.3 Verified USDC support on Monad — 2026-09-28

**Result: both Circle-listed deployments support the EIP-3009 receive authorization required by this design.** Addresses were checked against [Circle's canonical list](https://developers.circle.com/stablecoins/usdc-contract-addresses), then queried directly through public RPC. No transaction was submitted and no user wallet or funds were used.

| Read | Monad Testnet | Monad Mainnet |
| --- | --- | --- |
| Chain ID | `10143` | `143` |
| USDC proxy | `0x534b2f3A21130d7a60830c2Df862319e593943A3` | `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` |
| RPC | `https://testnet-rpc.monad.xyz` | `https://rpc.monad.xyz` |
| Pinned block number | `66405428` | `108748699` |
| Pinned block hash | `0x716c2bf9367b5f4ed84d827c08ede1b81c7602a5e95f3503b7a41eef15f0ad98` | `0x820ca99f8fbc611f3637e05e7065556cec175882a4d2687e3d5f2896ace49234` |
| Domain name / version | `USDC` / `2` | `USDC` / `2` |
| Decimals | `6` | `6` |
| Implementation address | `0x21240161521d6854be79f7d3a0a65c6beddb42fb` | `0xbd520ea8cbb4f81b62aff3c3ffe7affd69800b6d` |
| Implementation runtime code hash | `0x634d53fa0836dac59ab39f677cedcf9f7b0953960ddb24830b46b6db80aa8e54` | `0xe96489833045c42bacced6259e6a6372290706ed665e79457aa2fe4d46bc3559` |
| `DOMAIN_SEPARATOR()` | `0xf1090f5a61ddee19528cecc447be0f91c7205fc2b34dd271fc0de87809a0a48d` | `0xfe22123edc0dd4aeb912eb7948c5f0e531592c2053b3067612f427db342c93c6` |

The proxy implementation slot was read using `keccak256("org.zeppelinos.proxy.implementation")`; implementation runtime code was present (23,464 bytes each). Both domain separators matched a locally computed EIP-712 domain using the **proxy** as verifying contract. Use the returned name `USDC`, not a guessed `USD Coin` name from examples.

At each pinned block, an ephemeral random EOA signed `ReceiveWithAuthorization` with recipient `0x000000000000000000000000000000000000bEEF`, amount zero, `validAfter=0`, `validBefore=block.timestamp+600`, and a block-derived test nonce. `eth_call` used the recipient as caller and the USDC proxy as destination. Results on both networks:

- `receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)` succeeded with empty return data (`0x`); selector `0xef55bec6`.
- The overload ending in `bytes signature` also succeeded with the same valid authorization.
- Calling from a different address reverted with `FiatTokenV2: caller must be the payee`.
- Changing the amount from zero to one while retaining the signature reverted with `FiatTokenV2: invalid signature`.
- `RECEIVE_WITH_AUTHORIZATION_TYPEHASH()` returned `0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8`.
- `authorizationState(authorizer, nonce)` remained false after the simulations, as expected for nonpersistent calls.
- A separately signed `CancelAuthorization` passed an `eth_call` of `cancelAuthorization(address,bytes32,uint8,bytes32,bytes32)`.

These are successful signature-validation/execution simulations against deployed code, stronger evidence than ABI inspection alone. They use **zero-value token transfers**, latest blocks pinned per network, and no persisted state. They do not establish funded nonzero transfers, persistent replay/cancellation behavior, PayUnlock wrapper atomicity/order binding, wallet prompt counts, or fork/live end-to-end acceptance. Those tests remain required. Proxy state can change after the recorded block; confirm profiles again before deployment. This check authorizes no mainnet deployment or transaction.

## 4. Actor-aware contract architecture

Refactor business logic into internal helpers that receive an explicit actor, for example `_purchase(buyer, ...)`, `_reserve(seller, ...)`, and `_record(author, ...)`.

- Direct entry points obtain the actor from `msg.sender`.
- Authorized entry points obtain the actor only from a verified signature or USDC authorization.
- Relayers are transport/gas payers. They cannot become order buyers, sellers, authors, dispute participants, arbitrators, or payout recipients merely by submitting a transaction.
- Audit every role check, mapping key, codec/hash input, event author, assignment requester, refund, and payout. Current `_record`, `_message`, `_evidence`, and arbitration assignment use `msg.sender` and require particular care.
- Preserve fixed payout destinations and existing liabilities accounting. Never pay an arbitrary address supplied only by the relayer.
- Keep reentrancy protection at external execution boundaries and share private/internal helpers. Do not nest guarded external functions or implement an unrestricted self-call/delegatecall dispatcher.
- Do not use `tx.origin`, a mutable global actor variable, or an unverified calldata suffix to infer authority.

Native MON purchase entry points remain direct and user-funded, including gas. Conventional approval-based USDC purchase may remain as a direct compatibility path. Their availability must not make the sponsored USDC UI ask for MON or deploy TESTUSD. A zero-value action such as claiming an existing MON refund may still be sponsored: it pays from existing escrow rather than requiring a new native payment from the submitter.

## 5. Signed authorization for other actions

For actions that do not collect a new USDC payment, use a PayUnlock EIP-712 authorization, verified by the escrow. Proposed envelope:

```text
ActionAuthorization {
  actor,
  actionType,
  actionDataHash,
  nonce,                 // random bytes32; independent concurrent actions
  validAfter,
  deadline,
  nativeValue            // must be zero for authorized/sponsored action execution
}
domain = { name: PayUnlock, version: <new authorization version>,
           chainId, verifyingContract: escrowAddress }
```

`actionDataHash` commits to canonical ABI-encoded arguments, including the intended order/product, content references and encrypted envelopes, expected turn/revision/index, recipients where applicable, fees, and relevant expected state. Define per-action types and fixtures. Add expected version/state guards where a delayed signed update could otherwise overwrite a newer intent. Existing turn/revision checks remain authoritative.

Proposed entry points are `executeAuthorized(intent, actionData, signature)` and `executeDirect(intent, actionData)`. The direct form requires `intent.actor == msg.sender` and uses the same operation nonce and execution guards, allowing a direct fallback to invalidate a still-pending relayed copy.

- Use a finite action dispatcher. No arbitrary targets, arbitrary calls, token approvals, or ownership/admin actions in the public sponsored executor.
- Validate actor signature using the installed OpenZeppelin EIP-712/signature primitives, validity bounds, domain, action data, role, state, and exact `msg.value`.
- Authorized execution rejects nonzero `nativeValue` and `msg.value`. New MON payments use dedicated direct payable entry points; their signed transaction commits to the exact payment and gas. Do not route MON purchases or offer placement through the relayer.
- Store consumed/canceled nonces per actor. Mark consumption before external effects, with rollback on revert. Nonce reuse is prohibited across action types within this authorization domain.
- Emit an execution event containing actor, operation nonce, intent digest/action hash, and submitter. Actor remains the source of authority; the submitter field is informational.
- Provide bounded on-chain cancellation/invalidation, both direct and signed, with distinct cancellation types. Reject nested executor or cancellation recursion. Short expiry limits abandoned authorizations; removing a local job is not revocation.
- For repeated actions such as replies, updates, or evidence publication, direct-versus-relayed races must not duplicate effects or revive stale changes. UI fallback must reuse the same intent, not manufacture a fresh operation.

### 5.1 Action coverage

| Actions | Proposed route | Required invariant |
| --- | --- | --- |
| USDC purchase | Specialized USDC receive authorization | One signature; order-bound nonce; exact USDC amount; signed buyer |
| First offer creation | Direct payable creation; seller funds placement fee and gas | Exact placement fee/version, seller fee cap, product key, and payer bound; charge once |
| Update offer, disable sales, cancel product | PayUnlock action authorization | Seller and expected product state/version bound; no repeated placement charge |
| Reserve delivery / reserve batch | PayUnlock action authorization | Seller, exact order list, limits, state, deadlines |
| Publish delivery / publish batch | PayUnlock action authorization | Seller, exact references, finalized reservation checks, publication window |
| Accept delivery, buyer refund, seller withdrawal, timeout claim | PayUnlock action authorization | Current eligibility and fixed beneficiary; no relayer payout |
| Refund canceled batch, refund disputed order | PayUnlock action authorization | Seller authority and exact orders/amount outcomes |
| Open dispute, reply, submit evidence | PayUnlock action authorization | Participant identity, exact encrypted references, turn/revision |
| Arbitrator requests evidence or resolves case | PayUnlock action authorization | Assigned arbitrator, case revision/index, exact decision/reference |
| Request paid arbitration | Initiator-funded fee route below | Arbitrator sets price; requester pays; gas sponsor is not implicitly the fee payer |
| Arbitrator changes their own fee | PayUnlock action authorization or direct call | Only that enrolled arbitrator can change price; pending cases retain their snapshot |
| Platform fees/configuration, owner changes, arbitrator replacement/eligibility | Existing direct admin authority with explicit new fee setters | Admin cannot override an arbitrator's price or existing order fee snapshots |

Delivery remains reservation then publication with finality between them. Sponsoring fees does not collapse the existing two-stage delivery protocol. Bulk signatures cover explicit order lists and payloads, not an open-ended permission. Existing delivery sessions may authorize bounded requests only after their scope is updated and reviewed.

### 5.2 Arbitrator-set fee, paid by the initiator

Confirmed: the arbitrator sets their fee, and the buyer or seller requesting arbitration pays it. It is not deducted from order escrow, charged automatically to the losing party, included in the platform percentage, or absorbed by the gas relayer. Preserve the existing final/non-refundable fee policy after successful activation unless separately changed.

Current mismatch: `configureArbitrator(wallet, publicKey, fee, active)` is owner-only and sets the fee. Split administrative approval/activation/key-management authority from pricing. Add an actor-aware self-pricing method such as `setMyArbitrationFee(expectedFeeVersion, newFee)`. Existing administrative configuration must no longer overwrite the arbitrator's price. Require an explicit arbitrator price configuration before first paid activation; zero is a valid intentionally configured price. Keep key version and fee version separate.

Confirmed currency: **USDC**, supporting a specialized one-signature `requestArbitrationWithAuthorization` route. Bind the order, requester, arbitrator, key version, fee version, case state, exact fee/asset, evidence hash, request ID, validity window, and salt into the USDC authorization nonce. Use a distinct arbitration-purpose type hash, so purchase and arbitration authorizations cannot be substituted. Take USDC from the **initiator** into escrow and pay the agreed arbitrator atomically, separate from order liabilities. A zero-fee request uses the ordinary signed action route. Reject stale quotes and mismatched requester, asset, fee, or evidence before accepting payment.

Snapshot fee asset, amount, version, requester, and payment at activation. Subsequent arbitrator fee changes do not reprice an existing case. Concurrent initiators cannot create two assignments or two successful fee charges. A reverted activation transfers nothing; a completed fee payment is not repeated on evidence submissions or resolution. Arbitrator replacement currently does not charge another fee: preserve that behavior and do not silently charge the initiator again. Compensating a replacement is a separate future policy.

The current contract charges MON; new arbitration configurations must explicitly quote USDC smallest units and snapshots must carry the fee asset. Never reuse the old MON integer as a USDC amount or silently convert it. Old cases retain their old contract's fee terms. Sponsored activation requires the initiator's USDC balance but no MON; relayers pay only network gas. Direct activation can self-submit the same USDC packet and pay gas, or use an explicitly reviewed USDC allowance path. Reject `msg.value` on USDC fee routes. Do not wrap this specialized route in another mandatory PayUnlock signature; the USDC nonce commitment already binds the action.

### 5.3 Platform percentage deducted at settlement

Recommended rules:

- Configure `serviceFeeBps` and a nonzero, non-escrow treasury recipient through admin-only setters, with configuration events. Basis points avoid floating point: 100 basis points = 1%; zero disables the fee. Enforce `0 <= bps <= 10_000` and seller-approved product caps; a lower immutable business cap can be chosen before deployment.
- Each seller approves a `maxServiceFeeBps` on offer creation/update. A future admin increase above that cap blocks new purchases until the seller accepts it; it must not silently reduce proceeds from unattended offers beyond the seller's approved cap.
- Snapshot the applicable bps, recipient, and calculated fee per order at purchase, and include them in the reviewed terms/hash. Admin updates affect only future purchases. Existing paid orders cannot be repriced or have their earned-fee recipient redirected at withdrawal.
- Interpret “finished” as terminal financial settlement: `PaidOut` or `Refunded`. `confirmReceipt` currently only transitions to `Confirmed`; it is not a payout and must not charge a fee yet.
- On a seller outcome, compute `fee = floor(grossPrice * feeBps / 10_000)` using overflow-safe integer math, and `sellerNet = grossPrice - fee`. Charge in the order's own asset (USDC for USDC orders; MON only if a native direct order remains supported), with no extra buyer charge or allowance.
- Apply that split through shared `_settle(..., sellerWins=true)`, covering normal withdrawal, seller-favoring timeout, and seller-favoring arbitration. Never bypass it in an alternative settlement entry point.
- On any buyer refund outcome, return the **entire principal**, with zero platform percentage. Cover immediate refund, canceled/expired delivery, seller refund, buyer-favoring timeout, and buyer-favoring arbitration. Offer placement and already-paid arbitration fees remain separate.
- Charge once per order. Handle zero fee, tiny prices rounding to zero, and a zero net amount without unnecessary external transfers. UI shows gross price, platform percentage/amount, and seller net before seller consent and in final receipts.

Example: 100 USDC principal with a snapshotted 2.5% fee yields 97.5 USDC seller proceeds and 2.5 USDC platform revenue on seller payout. A buyer refund returns 100 USDC. No additional percentage is taken from an arbitration service fee.

Recommended fee accounting: accrue platform fees to a withdrawable treasury ledger rather than synchronously transferring to treasury during every settlement. A reverting native receiver or blocked treasury must not stop the buyer/seller's otherwise valid settlement. The platform can claim only accrued fees; no generic balance sweep. A claim may be submitted by anyone but always pays the recorded recipient, or requires that recipient's authority for any destination change. Outstanding fees may remain unclaimable if the token blocks that recipient; they must never be redirected by an unprivileged caller.

On seller settlement, mark the order terminal, remove gross principal from order liabilities, credit the protocol fee liability, and transfer seller net atomically. On refund, remove principal liability and return gross principal. On treasury withdrawal, reduce only treasury liabilities. Keep explicit per-asset totals:

```text
asset balance >= unsettled order principal
              + accrued unwithdrawn platform revenue
              + other explicitly reserved fee liabilities (if introduced)
```

Unsolicited transfers are not automatically distributable revenue. Add settlement events with gross, net, fee, rate, and recipient/credit status; update existing `Settled` consumers so a gross award is not falsely displayed as a full gross seller transfer. Expand order structs, codecs, checkout hashes, API schemas, and indexed projections consistently; these are ABI/protocol changes, not a frontend-only fee calculation.

### 5.4 Admin-configured MON offer placement fee

Proposed interpretation: the seller pays `offerPlacementFeeWei` once on successful first on-chain product creation. Admin configures the amount and treasury recipient; zero disables it. Charge nothing for off-chain drafts, failed/replayed creation, offer updates, pause/resume, or cancellation. A deliberately new product key is a new placement. The fee is earned when placement succeeds and is non-refundable on later cancellation or lack of sales; make this policy explicit in the placement review.

Bind the exact quoted fee, fee-configuration version, product key, seller, offer terms, and seller service-fee cap into the direct placement transaction calldata. Require a matching current quote at execution; an admin fee change must trigger review rather than an increased charge. Use exact payment amounts, not overpayment/refund behavior. Accrue earned placement fees to the native-asset treasury ledger, separate from order escrow.

**Confirmed funding mode: direct placement only.** The seller calls a payable creation entry point with `msg.value == quotedPlacementFee` and pays network gas. After any required sign-in and encryption-key preparation, placement is one funded transaction with one wallet transaction confirmation. Show the business fee and estimated gas separately and check the seller can fund both. A zero placement fee still uses direct creation for a consistent initial implementation.

No MON relayer funding, user-credit ledger, deposit flow, or sponsored placement is required. Native MON offer purchases follow the same direct-payment rule. Seller updates and other eligible zero-value actions can still be sponsored after placement.

### 5.5 Review conclusion and remaining decisions

The fee model is implementable with the new escrow. Shared `_settle` provides a clear place to apply the platform split, and actor-aware authorization supports initiator-paid arbitration. No inherent escrow-state-machine blocker was found in the inspected source.

There are material implementation changes: direct payable placement, per-order immutable fee snapshots, contract author/actor separation, treasury fee accounting, arbitrator self-pricing, versioned codecs/indexer/API types, and all settlement consumers. They require tests and live acceptance; this source review is not proof that the proposed implementation is correct.

Before ABI freeze, resolve or explicitly accept these proposed policies:

- Percentage on seller payouts only, full-principal refunds, purchase-time rate snapshot, and seller offer fee cap.
- Placement charged once per new on-chain offer and non-refundable after successful creation. Direct MON payment and user-paid gas are confirmed; no prepaid-credit feature is planned.
- Arbitration is confirmed as initiator-paid USDC, with admin-controlled eligibility and arbitrator-controlled pricing; finalize its exact self-pricing interface and fee-version checks.
- Initial rates/amounts/treasury, optional lower maximum bps, and unchanged replacement-arbitrator compensation policy.

There is no remaining MON-funding conflict under the confirmed scope: compatible token payments and eligible zero-value actions may be sponsored; users fund MON payments and their gas directly. USDC deployment capabilities are verified in section 3.3; funded integration and new contract size/gas budgets remain implementation verification gates.

The existing local compiled `PayUnlock` artifact contains 19,605 runtime bytecode bytes. This is an inspected artifact, not a fresh build or proof of the proposed version's size. Adding signed dispatch, fee ledgers, and payment paths increases code size; compile with the actual deployment profile and verify target-network and test-runner limits early. Keep shared logic internal and consider the existing linked-library pattern if the new build exceeds its budget, without introducing a privileged relay dependency.

## 6. Permissionless execution and direct fallback

Contract entry points must accept valid packets from any sender. A first-party API session, catalog DB row, known relayer, or backend signature must never be an on-chain execution requirement. Sponsorship policy belongs off-chain.

Publish a versioned execution packet format containing chain/deployment, intent and action data, token domain, signature when required, deadline, operation ID, target, native value, and reproducible calldata. Transport metadata must not change the signed action. Allow another relayer to execute the same packet without obtaining a fresh user signature.

Provide a documented SDK/helper and standalone submission/recovery command or static tool that works with public RPC, published ABI/manifests, and the packet, without PayUnlock's API. Support packet export and an advanced alternative-relayer setting. A first-party endpoint is the default convenience, not the only place calldata can be built.

| Situation | User experience | On-chain transactions |
| --- | --- | --- |
| Sponsored USDC checkout | Sign one USDC authorization; relayer submits | One purchase transaction; no buyer MON |
| First relayer unavailable, packet already signed | Retry same packet with another relayer | At most one successful purchase; competing submissions can revert |
| Signed USDC packet, buyer chooses direct | Review gas and confirm self-submission of the same packet | One purchase transaction; buyer pays MON; this is an additional interaction after signing |
| Direct from the outset using EIP-3009 | Sign USDC authorization, then confirm transaction | One transaction but two interactions; buyer pays MON |
| Direct conventional USDC purchase | Confirm purchase if allowance sufficient; otherwise approve then purchase | One or two transactions depending on allowance |
| MON purchase or MON offer placement | Review native amount and gas, then confirm a direct transaction | One transaction; user funds payment and gas; no relayer |
| Signed lifecycle action, buyer/seller chooses direct | Submit identical packet or actor-only direct envelope consuming the same nonce | One successful action; user pays MON |

Direct submission must not depend on the first-party gas-estimation endpoint. Estimate via the connected/public RPC when necessary. Insufficient MON in this mode prompts an explicit top-up, not a hidden change to signed terms.

Relayer independence does not automatically decentralize catalog metadata, encrypted storage, or every frontend/API dependency. The deliverable here is independent execution and chain recovery of a known authorized action, with the remaining application dependencies documented honestly.

## 7. Relayer service and persistence

Add a separate relayer service/worker using the existing Fastify/PostgreSQL architecture. Its signing key is a dedicated gas-paying account, separate from the escrow owner, arbitrator, seller, and user keys. It receives no custody of buyer USDC and no contract administrator role.

Proposed first-party endpoints:

- `GET /relay/capabilities`: chain/deployment, supported actions, token/domain metadata, sponsorship availability and limits.
- `POST /relay/operations`: validate a complete signed packet and idempotently enqueue it; return operation ID/status. First-party anti-abuse checks may require app authentication, but alternative submission must not.
- `GET /relay/operations/:id`: bounded operation status and known transaction hashes, with appropriate access controls. A public-chain result remains independently verifiable.

Implementation requirements:

- Persist the packet and durable state before acknowledging acceptance. Encrypt retained executable signatures at rest, restrict access, redact logs/analytics, and purge them after expiry/final resolution under a documented retention policy. Signatures authorize execution even though they cannot reveal private keys.
- Idempotency key includes chain, escrow, actor, and operation nonce/request ID. Reject the same identity with conflicting payloads. Multiple authorization attempts for one checkout share its purchase request ID.
- Separate operation state from transaction attempts. Suggested states: `accepted`, `queued`, `submitted`, `provisional`, `finalized`, `expired`, `canceled`, `rejected`, `uncertain`. A failed outer attempt does not necessarily mean the action failed elsewhere.
- Use transactional job leasing and a single nonce-allocation authority per funded relayer account. Persist reserved EOA nonce, signed raw transaction, computed hash, and attempt before broadcasting; recover them after crashes or ambiguous RPC responses.
- Fee replacements use the same outer nonce and action. Reconcile pending nonce/receipts across restarts and replicas. Do not issue fresh user intent IDs on network timeout.
- Validate signature, domain, commitment, actor, deadlines, state, allowed action, all fee quotes/caps, and zero attached native value; then simulate from the actual submitting account and estimate gas. Reject MON-payment routes from the relayer API. Client/relayer prechecks do not replace contract enforcement.
- Bound action calldata, batch sizes, per-account and global sponsorship budgets, queue depth, gas price/limit, and retries. Rate limiting alone is insufficient against funded-key exhaustion. Do not accept arbitrary user transactions for sponsorship.
- Revalidate immediately before submission. Expired or stale requests require explicit user review where terms change. Deadline-sensitive disputes and publication need queue prioritization and visible fallback before expiry.
- Low MON balance, budget exhaustion, provider failure, or maintenance marks sponsorship unavailable. It must not pause permissionless contract execution or direct submission.
- Monitor queue age, finality delay, gas spending, account balance, failures, nonce gaps, and deadlines. The gas budget does not fund initiator-paid arbitration or seller placement fees. Native funds attached by a relayer must not be mislabeled as funds paid by the user.

No additional relay commission or USDC gas reimbursement is included initially. The platform earns the configured settlement percentage and placement fee under the separate rules above. It may fund the relayer from withdrawn treasury revenue off-chain; the relayer cannot withdraw customer principal. Adding an extra relay charge later requires an explicitly signed fee and recipient.

## 8. Frontend, signatures, and recovery

- Add typed-data signing to `types.ts`, `managed-session.ts`, MetaMask, and WalletConnect adapters, and update required WalletConnect methods/capability handling. Unsupported wallets receive an honest direct compatibility option.
- Built-in wallets show one understandable payment/action confirmation and then sign the validated typed data. Mera/session scope must include only the reviewed domain, contract, method/action, amount, and validity constraints. Existing sign-in or receiving-key permission is not payment consent.
- Keep private keys, receiving-key signatures, seeds, and plaintext content out of relayer packets. USDC authorization signatures are public once executed and must never be used as encryption-key derivation material.
- Sponsored payment shows the USDC price and that network fees are covered. No buyer MON check or Approve Token step in this route. Wait for authorization and finalized purchase, not a second transaction-signing popup.
- Continue to display real service fees such as arbitration. Gas sponsorship must not hide their existence.
- Add admin service-rate, MON placement-fee, and treasury configuration; seller offer fee-cap and direct placement review; and arbitrator self-pricing. Show fee units correctly (USDC decimals versus MON wei), expected seller net, full-refund behavior, and fee-change review states. MON payments display native amount and gas and require a funded wallet; do not offer sponsorship for them. Remove wording that a seller-favoring arbitration transfers the entire gross amount to the seller.
- Add an explicit `Pay network fee myself` option, shown with the estimate before submission. A declined signature does not trigger automatic paid fallback.
- Preserve signed packet identity while switching submitters. A timeout is uncertain, not permission to buy again. Retry the same packet/request ID, and detect completion by another relayer.
- Keep the existing purchase journal's no-signatures rule unless its storage policy is deliberately revised. Persist nonsecret intent fields/IDs and hashes; retain executable packets in controlled relayer storage or user-approved export. In-memory lost signatures can be recreated for the same intent after checking chain state and expiry.
- Store multiple transaction attempts and authorization state independently of the local browser session. RPC receipts and escrow events/state are authoritative; relayer status is advisory.
- Update `chain-service.ts`, batch-status routes, publication verification, registration decoding, `reconcile.ts`, purchase/lifecycle/bulk journals, and the indexer. Decode authorized envelopes; match the exact actor, action digest, deployment, request/order, and effects. Do not simply remove `receipt.from` checks without replacing them with proof of the intended action.
- For reverted transactions, use verified calldata/envelope and receipt status; an execution event will not exist. For successful transactions, require matching contract events and finalized state. Preserve canonical-block/reorg checks.
- Run the stateless test again: after clearing storage or changing devices, recover the wallet/receiving identity and finalized purchases from passkey plus public/untrusted data. A local relay job ID or stored signature must not be required to recover completed ownership or decrypt delivery.

## 9. Clean development reset, deployment, and TESTUSD removal

- Add a new immutable escrow deployment/ABI version (next available version after the current v4), including verified actor execution and authorization events.
- Configure official USDC per chain in deployment parameters/manifests. Enable it through deployment configuration; remove TESTUSD deployment/enablement and frontend token presentation. Update scripts that assume `testToken` exists.
- Discard current development orders and recreate/re-publish offers against the fresh contract. No historical-order migration, old-order frontend, or multi-deployment settlement support is required. Old TESTUSD balances cannot be converted or renamed into USDC.
- Remove the custom TESTUSD from application/demo setup. Automated isolated contract tests may use a USDC-interface fixture; label it test-only and never deploy or advertise it as a payment asset. Add fork/live acceptance against Circle USDC to cover behavior mocks cannot prove.
- Keep existing public deployment manifests/ABIs as historical records; do not overwrite or reuse old deployment IDs. A DB reset does not revoke old signatures or move on-chain funds. No transactions against old funds are part of the reset.
- Identify and verify the exact dedicated PayUnlock development database/schema, indexer deployment state, and application-owned storage before destructive commands. Existing reset authorization covers those development resources only. Do not delete shared PostgreSQL servers/volumes, unrelated databases, SDK/Message Lab data, wallet/passkey credentials, or imported private keys.
- Stop the API, relayer worker, and indexer writers during reset. Clear/recreate only PayUnlock development commerce data, relay jobs/attempts, and its dedicated indexer projections/checkpoints; reapply migrations. Remove only orphaned application-owned offer/content metadata as appropriate; do not recursively delete unrelated storage.
- Invalidate old app auth sessions and deployment-scoped browser purchase/lifecycle/delivery journals through a version/deployment namespace change. Keep wallet vaults and saved passkey-account hints. Old journals must never submit transactions to the fresh contract. New offers/purchases use new receiving contexts containing the new deployment address.
- Update backend deployment loading, indexer contract/ABI/start block, frontend configuration, and chain-scoped DB keys together. Build projections from the new deployment block and verify old orders do not reappear through an old indexer subscription.
- Export and verify contract sources/ABI, deployment block, authorization version, USDC address/domain, chain ID, and enabled assets. Publish an operator-independent submission/recovery guide.
- Initialize explicit platform bps, treasury, and MON placement amount; obtain fresh USDC fee settings from arbitrators. Do not copy old MON fees into USDC configuration. The fresh application uses the new fee snapshots, hashing schema, and events exclusively; retained old artifacts are historical records, not a requirement for old-order application compatibility.
- Perform the authorized destructive reset only after implementation and local/fork checks are ready for cutover, not while merely editing this plan. Then use fresh offers and USDC test purchases for acceptance.
- Old commerce history will intentionally be unavailable after reset. Rollback may require another development reset/redeployment; do not promise recovery of discarded rows. A failed rollout cannot move new-contract funds back to the old escrow.

## 10. Implementation phases

### Phase A — verify and freeze the signing specification

- [x] Verify deployed USDC receive/cancel interfaces and EIP-712 domains on Monad testnet and mainnet through read-only simulations (section 3.3).
- [ ] Recheck token profiles before deployment and complete funded fork/live integration tests; initial capability verification is not full checkout acceptance.
- [ ] Generalize token configuration and signed intents: allowed assets, verified authorization modes, exact token address/domain, and direct-only fallback. USDC is the first example, not a constructor-wide token restriction.
- [ ] Finalize purchase nonce commitment, lifecycle envelope, cancellations, event schema, and direct-entry semantics with shared TypeScript/Solidity vectors.
- [ ] Freeze confirmed initiator-paid USDC arbitration, arbitrator self-pricing, fee-version checks, and assignment snapshots.
- [ ] Confirm detailed percentage/refund/snapshot policies and placement charging trigger; select initial rates, caps, amounts, and treasury before deployment. MON payments are already confirmed as direct and unsponsored.
- [ ] Inventory the `msg.sender` and transaction-sender assumptions listed above, including dependencies in codecs, delivery sessions, and indexer projections.
- [ ] Record updated decisions in `docs/local/IMPLEMENTATION_PLAN.md`, contract design/functions, and tracked build-critical documentation during implementation. This plan supersedes historical payment, fee, and migration decisions; preserve current source behavior for unrelated lifecycle and encryption rules.

### Phase B — contract and protocol tests

- [ ] Implement actor-based internal actions and specialized USDC purchase authorization.
- [ ] Add bounded lifecycle authorization, nonce consumption/invalidation, execution events, and direct fallback using the same operation identity.
- [ ] Cover buyer, seller, and arbitrator actions; preserve all existing escrow invariants and delivery finality boundaries.
- [ ] Implement the agreed arbitration fee route; retain explicit unsupported-mode messaging until complete.
- [ ] Implement snapshotted platform fee split, seller caps, treasury accrual/withdrawal, and full-principal refund behavior across every settlement path.
- [ ] Implement quoted direct payable MON placement; account for earned treasury fees separately from order liabilities. Exclude native-payment routes from authorized execution and relayer sponsorship.
- [ ] Split admin arbitrator eligibility from self-priced USDC fees; update codecs, schemas, events, indexer projections, and UI fee semantics.
- [ ] Verify deployed bytecode size, batch gas bounds, ABI compatibility strategy, and regenerated artifacts.

### Phase C — relayer and transport-independent recovery

- [ ] Add schema migrations, durable jobs/attempts, funded-account nonce management, worker, sponsorship policy, and metrics.
- [ ] Add versioned packet encoding, simulation, status endpoints, and independent submission tools.
- [ ] Replace sender-based ownership assumptions with actor/action/effect verification throughout backend and indexer.
- [ ] Validate restart, replacement, replay, alternate-relayer, and reorg behavior before connecting the UI.

### Phase D — wallet and application flows

- [ ] Add reviewed EIP-712 signing to all supported wallet adapters and managed sessions.
- [ ] Implement sponsored USDC checkout with one signature and no MON requirement.
- [ ] Add explicit alternative-relayer and user-paid paths; update journals and reconciliation.
- [ ] Extend the same interaction model across seller, buyer, and arbitrator screens.
- [ ] Add direct MON placement fee/gas review, seller net proceeds, admin fee settings, and arbitrator fee management; scope MON-free messaging to sponsored USDC payments and eligible zero-value actions.
- [ ] Preserve deferred unlock, explicit sign-out behavior, encryption recovery, and intentionally repeated purchases.

### Phase E — testnet deployment and acceptance

- [x] Remove TESTUSD from deployment/demo paths, configure Circle USDC, deploy and read back the new escrow and router. Explorer source verification remains to be done.
- [ ] Complete the authorized dedicated development DB/indexer reset, fresh offer creation, and synchronized deployment configuration; verify old journals/history cannot leak into the new deployment. The reset, migration, configuration, and indexer restart are complete; an on-chain V5 acceptance offer and two orders exist. A new catalog offer and browser recovery checks remain.
- [ ] Run the acceptance matrix below with evidence that distinguishes local, fork, browser, and live testnet results.
- [ ] Document relayer key funding/rotation, budgets, outage/direct recovery, and remaining application dependencies.

## 11. Required acceptance matrix

| Test | Required result |
| --- | --- |
| Signed-in buyer with receiving key, USDC, and zero MON | One payment signature; one finalized purchase transaction; relayer pays gas |
| Built-in/passkey, MetaMask, WalletConnect | Expected prompt count and correct identity; unsupported typed signing has explicit fallback |
| Unregistered third-party submitter | Same signed packet executes successfully without first-party service approval |
| First-party relayer/API offline | Independent packet construction/submission tool can execute a known action via another submitter or direct RPC |
| Buyer opts to pay gas | Gas estimate and transaction approval shown; signed packet reused; no hidden fee switch |
| Two relayers plus direct submission race | At most one purchase/effect; losers reconcile completion, no double debit |
| Mutated seller, offer, receiving key, amount, expiry, deployment, chain, request ID, or salt | Authorization rejected; no transfer/order |
| Raw USDC call using a ReceiveWithAuthorization signature | A third party cannot consume the escrow-directed signature outside the escrow wrapper |
| Token failure, changed terms, insufficient USDC, expired/canceled authorization | Atomic failure; no partial order/deposit or consumed nonce from reverted execution |
| Same request re-signed with a new nonce/expiry | Existing order recovered; no duplicate charge; deliberate new request allows a second purchase |
| Wrong actor, old turn/revision/index, reordered or modified batch, stale product edit | Rejected without privilege escalation or unexpected overwrite |
| Relayed delivery/dispute/evidence/arbitration | Actor retained in role checks, record hashes, events, assignments, and payout destination |
| Relayer crashes before/after broadcast; response lost; worker concurrency | Durable recovery without lost nonce tracking or duplicate intent |
| Fee replacement, reorg, provisional receipt, stale indexer | Finality respected; uncertain status does not create a new purchase |
| Relayer empty/budget exceeded; deadline-sensitive action | Explicit alternative/direct option; protocol remains executable |
| Pending authorization canceled or direct intent executed | Later relayed replay fails; local deletion alone is not treated as cancellation |
| Arbitration activation by buyer or seller | Exact reviewed USDC fee debited from initiator and paid once to arbitrator; principal untouched; relayer pays gas only |
| Arbitrator self-pricing / admin eligibility | Another arbitrator/admin cannot alter this arbitrator's price; stale activation quote rejects; existing assignment price remains fixed |
| Concurrent arbitration requests or replacement | One activation fee; no second charge on replay/replacement/evidence/resolution |
| Seller settlement by withdrawal, timeout, or arbitrator | Gross = seller net + exactly one snapshotted platform fee; no double charge at confirmation |
| All buyer refund outcomes | Buyer receives full principal; no platform percentage; separate earned business fees remain unaffected |
| Admin changes service rate/treasury while orders or signatures exist | Paid orders unchanged; stale pending quote rejects; new purchase above seller-approved cap rejects |
| Fee math at zero, tiny amounts, maximum bps, large prices | Defined rounding, no overflow/underflow, zero-value transfers skipped, accounting conserved |
| Treasury cannot receive or claim | Accrued fee remains isolated; no unrelated seller/buyer settlement blocked by treasury transfer |
| MON placement: draft, first publication, replay, update, pause, cancel | Charge once on successful creation; no fee on draft/failed/replayed creation or routine edits; earned placement fee not refunded on cancellation |
| MON placement fee changes before execution | Signed fee/version mismatch requires review; no increased debit |
| Direct MON placement or purchase | One funded transaction; exact payment plus sufficient gas; no relayer request or sponsorship promise |
| MON payment submitted to authorized executor or relayer API | Rejected; no sponsored native payment and no implicit native user credit |
| Storage cleared/fresh device | Finalized orders and encrypted access reconstruct; no dependence on local relay metadata |
| Authorized development reset | Only PayUnlock development data is reset; wallets and unrelated databases retained; old orders absent |
| Old signed request/journal used against new deployment | Domain/address mismatch rejects; no reuse of old receiving contexts or operation records |
| Additional admin-enabled token | Direct payment works only if its transfer behavior is supported; sponsorship remains disabled until its exact authorization mode/domain is verified |
| Token substitution or authorization-mode change | Signed intent rejects a different token/domain/mode; user reviews changes explicitly |

Security-critical contract tests must cover replay across chains/contracts/action types, unauthorized relayer parameter substitution, reentrancy, signature/domain errors, cancellation races, expiry boundaries, and fixed-beneficiary payouts. Run existing contract lifecycle tests and targeted backend/frontend suites in addition to new tests. A mock-only pass is insufficient to claim USDC compatibility or the one-interaction user experience.

## 12. References and verification limits

- [Circle USDC addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses): canonical network-specific asset addresses. The project already presents the Monad Testnet address in `token-icons.ts`.
- [Circle EIP-3009 implementation](https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v2/EIP3009.sol) and [token design](https://github.com/circlefin/stablecoin-evm/blob/master/doc/tokendesign.md): authorization semantics and recipient-only receive path.
- [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009): typed authorization, nonsequential nonce, validity, and atomic contract interaction. Retrieved during planning through docs-mcp-server; Circle is not separately indexed in the local library catalog.
- [OpenZeppelin signature utilities](https://docs.openzeppelin.com/contracts/5.x/utilities): EIP-712/signature verification building blocks. The repository currently pins OpenZeppelin Contracts 5.6.1; confirm exact installed interfaces during implementation.

The order-bound nonce commitment and lifecycle executor are PayUnlock designs, not claims that Circle validates PayUnlock order details. The local V5 contract tests cover the nonce, one-signature payment, fee split, arbitration payment, and a bounded action allowlist. A mock-token test does not replace a funded Circle USDC test. The V5 testnet deployment and dedicated database reset completed on 2026-09-28; deployment read-back confirmed Circle USDC name/version, enabled authorization mode, linked router, owner, and zero initial fee settings. The separate relayer was funded with 0.5 test MON and its worker started. Neither the deployer nor relayer had testnet USDC at the time of the balance check.

## 13. Readiness to start implementation

**Ready to start the implementation phases.** The required USDC signed-transfer capability is verified on both Monad networks, fee roles and currencies are defined, MON payments are explicitly direct, and the development reset removes the need for historical-order migration.

Use the recommendations in this plan as implementation defaults: seller-payout-only service fee, full-principal buyer refunds, purchase-time fee snapshots with seller-approved caps, and placement charged once on successful creation. Keep those choices explicit in UI and tests. USDC remains the initial arbitration fee asset previously confirmed; model fee assets explicitly so other verified supported tokens do not require hardcoding the entire protocol around USDC. A different arbitrator fee asset requires a new reviewed quote and verified capability profile.

Initial numeric fees, treasury address, and relayer funding/budget are deployment configuration, not blockers to writing and testing the implementation. Use explicit configurable development defaults (zero platform/placement fees until configured, nonzero test fixtures to exercise fees), no invented production rates, and a clearly selected treasury before enabling nonzero fees. Before live deployment, verify the existing operator configuration without printing secrets and fund the separate relayer account.

Remaining engineering gates include relayer restart/reorg acceptance, supported-wallet prompt counts, direct fallback and live fee settlement checks, and the final browser acceptance matrix. Funded Circle USDC integration and independent relayer submission now pass on Monad Testnet; the buyer retained zero MON. The full frontend suite passes (253 tests), as do backend tests and typechecks. The escrow runtime is currently 24,370 bytes under the 24,576-byte EVM limit; changes to it require another size check. The local app, backend, and indexer now select V5.
