# onebook architecture

## Layers

```
 Venue adapters  →  Spec extractors  →  Matcher  →  Router  →  Execution (planned)
 (per venue)        (per venue ×        (generic)   (generic)   NEAR Intents + Chain Signatures + queue
                     market type)
```

Each layer only depends on the one before it through a typed boundary:

| Layer | File(s) | Knows about venues? | Pure? |
|---|---|---|---|
| Spec model | `src/lib/spec.ts` | no | yes |
| Extractors | `src/lib/extractors/<venue>.ts` | yes (raw API shapes, rules wording) | yes |
| Adapters | `src/lib/venues/<venue>.ts`, `index.ts` | yes (HTTP, books, fees) | no (network) |
| Matcher | `src/lib/matcher.ts` | no | yes |
| Router | `src/lib/router.ts` | no | yes |
| API/UI | `src/app/**` | through the registry only | no |

### Extending

- **New market type on an existing venue:** add an extractor that returns a `PayoutSpec`, then register
  the series or slug pattern in that venue's adapter. Matcher, router and UI stay unchanged.
- **New venue:** implement `VenueAdapter` (`src/lib/venues/types.ts`), add extractors for the market types
  it lists, and add it to `VENUES` in `src/lib/venues/index.ts`.
- **New kind of difference** (e.g. settlement currency): add a field to `PayoutSpec`, have the
  extractors fill it, and add one comparison rule in `compareSpecs` with a severity.
- **Free-form events:** use the `event` spec kind, hand-written for now. Later, an LLM drafts the spec
  from rules text and a human approves it. The matcher already handles `event` specs.

## PayoutSpec

A spec describes when the **yes** leg pays $1. Extractors map venue labels onto yes/no ("Up" → yes,
Hyperliquid side 0 → yes). Kinds:

- `price-compare`: YES iff `price(end) cmp price(start)`. Used for up/down markets.
- `price-threshold`: YES iff `price(at) cmp strike`. Used for "above $X at T" ladders.
- `event`: proposition, source, cutoff, edge-case rules.

Each `PriceRef` is `{asset, oracle, aggregation, at}`. `aggregation` is `point` or
`average {seconds, anchor: trailing|unspecified}`. Timestamps are normalised to ISO UTC, so equal
times compare equal as strings.

### Safety rules

1. **An unrecognised rules text means no spec, and no spec means the market is never routed.**
   Extractors match on the wording of the rules, not just on titles. If a venue changes its template,
   extraction fails closed.
2. Differences that change the payout condition (asset, time, comparator, strike, proposition, cutoff)
   are **blocking** and give the tier `related`.
3. Differences that can flip the outcome in edge cases (oracle, averaging, resolution source, edge-case
   rules) are **warnings** and give the tier `near-equivalent`. Routing then requires explicit opt-in.
4. Even `equivalent` markets carry resolver risk: two oracles or resolution committees can disagree.
   The UI and docs say so.

## Matcher

`matchListings` buckets listings by `(asset, settlement time)` (or `(cutoff, proposition)` for events),
then runs `compareSpecs` on every **cross-venue** pair in a bucket. The output for each pair is
`{tier, diffs[]}`, and each diff carries `{field, a, b, severity}`.

## Router

`planRoute(books, side, budgetUsd)`:

1. Merges the ask levels of every book and sorts them by effective price (`price + fee per share`).
2. Fills greedily until the budget is spent.
3. If a venue's share is under its minimum order (shares or USD notional), drops that venue and refills.
4. Reports allocations per venue (shares, cost, fees, average price, **limit price** = worst level
   touched), plus the best single-venue result for comparison.

The limit price for each venue becomes the worst acceptable price in the signed order (see Execution).

`/api/quote` never trusts the client. It re-lists markets, re-extracts and re-compares every pair, and
only then fetches the books.

## Execution (built; venue submission is a dry run)

### Custody model

The user's NEAR account owns every position. On each venue's chain the position sits at an address
derived with Chain Signatures from `(NEAR account, path)`. onebook never has custody of funds.

### Flow as built (`src/lib/orders/engine.ts`)

Execution routes the whole amount to Polymarket, the only venue whose orders onebook can sign today. The
multi-venue split stays a quote.

```
POST /api/orders           route → 1Click quote (wNEAR → USDC on Polygon, recipient = derived address,
                           refund = user's NEAR account) → V2 order sized from the quote's minAmountOut
                           at the live limit price
  AWAITING_SIGNATURE       wallet sends v1.signer.sign(order hash). NO FUNDS MOVE.
POST /:id/signed           server recovers the signer from the MPC result; it must equal the derived address
  AWAITING_DEPOSIT_TX      separate click: wallet sends wrap.near [storage_deposit, near_deposit, ft_transfer]
POST /:id/deposited        tx hash forwarded to 1Click /deposit/submit
  AWAITING_SWAP            worker polls 1Click /status
    ├─ SUCCESS             → SWAP_SETTLED (USDC is at the user's derived address)
    └─ REFUNDED/FAILED/    → SWAP_FAILED (1Click returns the NEAR to the user's account)
       INCOMPLETE_DEPOSIT
  SWAP_SETTLED             worker reads USDC.balanceOf(derived address) on Polygon and records the exact
                           CLOB payload (order + signature, FOK)
  ORDER_DRY_RUN            final. Not posted: geo restriction (README → Compliance).
  EXPIRED                  unfunded past expiresAt = min(created + 20 min, market close − 60 s)
```

Why this handles atomicity: the order is signed before any money moves, the swap leg refunds itself if
it fails, and the order can only fill at or below the price the user signed. In the worst case the user
holds USDC at an address they control. There is no state in which onebook holds user funds.

Safety limits: `MAX_ORDER_USD` (default $10) per order, Polymarket's 5-share minimum, shares rounded
down so the order never spends more than the swap guarantees. Wallet prompts are separate, explicit
clicks.

### Queue

- `orders` table in SQLite (`node:sqlite`, `.data/onebook.db`, git-ignored): one row per order with the
  full record as JSON (state, quote, signed order, event log).
- Worker: `src/instrumentation.ts` starts a 5-second `tickAll()` when the Next.js server boots.
  `GET /api/orders/:id` also advances the order one step. `advance()` is idempotent and guarded against
  concurrent runs. Transient RPC or 1Click errors are retried on the next tick.
- It survives restarts because all state is in the table. Hackathon scale: one Node process, no broker.

### Withdraw (`src/lib/withdraw`)

The way back: USDC at the user's Polygon address → NEAR in the user's NEAR account.

```
POST /api/withdrawals {account}   reads USDC + POL at the derived address
  NEEDS_GAS            no POL for fees: 1Click quote 0.03 NEAR → POL (recipient = derived address,
                       refund = NEAR account); the wallet sends the wrap.near deposit (one approval)
  AWAITING_GAS         worker waits until POL >= gas × maxFeePerGas for a transfer
  READY_TO_SIGN
POST /:id/prepare      1Click quote USDC → NEAR (EXACT_INPUT, whole balance, recipient = NEAR account,
                       refund = derived address) + unsigned EIP-1559 USDC.transfer(depositAddress)
  AWAITING_SIGNATURE   wallet sends v1.signer.sign(keccak(tx)) (one approval); expires after 10 min
POST /:id/signed       server attaches r,s,v, checks the signer recovers to the derived address, broadcasts
                       on Polygon, reports the tx hash to 1Click
  AWAITING_SWAP        worker: receipt reverted → FAILED; 1Click SUCCESS → DONE; REFUNDED → FAILED
                       (USDC back at the derived address)
```

Gas comes from NEAR Intents too, so the user never needs a Polygon wallet. A later improvement is to
include a little POL in the buy flow so the gas step disappears.

### Live split orders on regulated venues (`src/lib/live`)

A second execution path, for venues where the user trades from their own verified account instead of an
on-chain address: Kalshi and Polymarket US (both CFTC-regulated, `LIVE_VENUES`). Users connect their own API
keys; **the secrets never leave the browser**.

```
connect   browser: import key as a NON-EXTRACTABLE WebCrypto key (Ed25519 / RSA-PSS), store in IndexedDB,
          check it with a signed balance read
plan      POST /api/live/plan {markets, side, budgetUsd, requestId}
          guards: ONEBOOK_LIVE_ORDERS=on, budget <= MAX_LIVE_USD ($10), only LIVE_VENUES, unique requestId
          computeQuote() re-lists, re-checks fungibility, reads live books → exact order body per leg
          (Kalshi whole contracts, Polymarket US 0.01), plan valid 30 s
send      Polymarket US: POST /api/live/:id/claim (once, while fresh) → browser signs and posts the planned
                         body to api.polymarket.us (CORS allows it) → POST /api/live/:id/report
          Kalshi:        browser signs `ts + POST + /trade-api/v2/portfolio/events/orders` → POST
                         /api/live/:id/kalshi {leg, keyId, ts, signature} → server forwards ONLY the planned
                         body for that leg, once, while fresh (Kalshi rejects auth headers from browsers)
result    per leg filled / not-filled / error; outcome all-filled | partial | none-filled
          (live_executions table, same SQLite file as the order queue; GET /api/live/:id)
```

Neither venue's signature covers the request body. That is why the relay never accepts a body from the
client: it sends the body it planned for that leg. A signature is only valid for one timestamp and path.

Atomicity: each leg is all-or-nothing at its limit price, but legs are not atomic with each other. A partial
route (one venue filled, one killed because its book moved) is reported, not retried or unwound. With a $10
cap the worst case is a smaller position than planned at a price no worse than quoted.

Production path: Polymarket US's ISV partner program (firm-level auth, in-app KYC, accounts provisioned on
approval). Bring-your-own-key stays as an option alongside it.

How NEAR fits here: regulated venues hold funds in the user's own account (deposits must come from accounts
in the user's name), so positions are not at a Chain Signatures address and 1Click cannot fund them directly.
NEAR stays the settlement layer for on-chain venues.

TODO(verify): Polymarket US BUY_SHORT price convention in a live order (docs say prices always refer to YES);
the `/v1/account/balances` response shape; Kalshi fractional counts on 15m markets (we send whole contracts);
WebCrypto Ed25519 support in the user's browser (recent Chrome, Firefox, Safari).

### Gaps before live trading

- pUSD: Polymarket V2 settles in pUSD; 1Click delivers USDC. A USDC → pUSD wrap transaction (signed via
  Chain Signatures) is needed, plus the exchange approvals and a little POL for gas (1Click can deliver
  POL too).
- CLOB API credentials for each derived address (L1 auth message signed via MPC).
- A venue the operator may legally route to (Kalshi via DFlow, Polymarket US).

### One-time setup per derived address (Polymarket)

- Token approvals for the exchange contracts. These are on-chain and need a little gas token (POL),
  which can also be delivered by Intents.
- CLOB API credentials, derived by signing Polymarket's auth message through the MPC signer. The server
  stores them. They can only post or cancel orders the user has already signed.

### Chain Signatures facts (verified 2026-11-11)

- MPC contracts: `v1.signer` (mainnet), `v1.signer-prod.testnet` (testnet).
- Derivation path for user EVM addresses: `onebook-evm-1` (`src/lib/near/chainsig.ts`). One path gives
  one address on every EVM chain. **Never change it**, because that would change every user's address.
- chainsig.js derives addresses locally from the MPC root key. This was checked against the contract's
  own `derived_public_key` view call for `example.near` → `0x614ed9cC94913BFb33d7a70A8460547379Ca8D0E`.
  (The example address on docs.near.org does not match the current root key.)
- `sign` is a function call with **1 yoctoNEAR attached** and 300 TGas prepaid. Function-call access keys
  cannot attach a deposit, so every signature needs the user's full-access key, i.e. a wallet
  confirmation. This is why orders are signed up front at quote time, not later by the queue.
- EIP-712: `EVM.prepareTypedDataForSigning(typedData)` → `contract.sign({payloads, path, keyType: "Ecdsa"})`
  → `EVM.finalizeTypedDataSigning`.

### Signing flow as built (`/sign-test`)

1. `POST /api/sign/prepare {account}` derives the user's EVM address, builds a Polymarket V2 BUY order with
   `maker = signer = that address` and `signatureType = 0` (EOA), hashes it (EIP-712), and returns the
   NEAR transaction for `v1.signer.sign`.
2. The browser sends that transaction through the connected wallet (`@hot-labs/near-connect`). The
   wallet holds the keys; onebook never sees them.
3. `POST /api/sign/verify` converts the MPC result (`big_r`, `s`, `recovery_id`) to r||s||v and checks
   that `recoverTypedDataAddress` equals the derived address.

Polymarket CLOB V2 (live 2026-04-28): domain `Polymarket CTF Exchange` v`2`, chainId 137, exchange
`0xE111180000d2663C0091e4f400237545B87B996B` (neg-risk `0xe2222d279d744050d28e00520010520000310F59`).
Order fields: salt, maker, signer, tokenId, makerAmount, takerAmount, side, signatureType, timestamp,
metadata, builder. Expiration is sent with the order but not signed.

TODO(verify) before live use: signatureType meanings in V2; timestamp unit (ms assumed); pUSD contract
address; 1Click supported destination chains and assets (pUSD is probably not a direct 1Click target, so
a USDC → pUSD wrap step may be needed).

### Venue notes

| Venue | Chain | Collateral | Order signing | US status |
|---|---|---|---|---|
| Polymarket (intl) | Polygon | pUSD (USDC-backed ERC-20, CLOB V2) | EIP-712 V2 Order, secp256k1 | close-only (cannot open) |
| Kalshi via DFlow | Solana | USDC | Solana tx; Proof KYC required to buy | US-regulated; KYC |
| Hyperliquid HIP-4 | HyperCore | USDH (verify) | secp256k1 typed data | excluded by ToS (verify) |

The data layer for Kalshi uses Kalshi's own public API. Execution would go through DFlow's tokenized
markets on Solana.

## Known gaps

- Fees: Kalshi's published formula is modelled without per-order rounding. Polymarket US uses
  0.095 × C × p × (1 − p) (tier 1; banker's rounding ignored). Polymarket (international) and Hyperliquid
  fees are treated as 0, but a third-party comparison lists 0.07 × C × p × (1 − p) for Polymarket
  international 15m markets (TODO verify).
- The Hyperliquid adapter is written against third-party docs. The live endpoint was unreachable from
  the dev machine when it was written.
- Polymarket's 2026 TWAP wording does not say where the 60s window sits. It is modelled as
  `anchor: "unspecified"`, which keeps BTC pairs at near-equivalent even if the oracles were the same.
- Market previews in the UI come from listing endpoints. Only `/api/quote` reads live books.
- Polymarket US public books are served through a CDN cache (`cache-control: max-age=30`), so a quote can
  use a book up to 30 s old. Live legs are fill-or-kill, so a stale price fails safely (not filled) rather
  than overpaying. Fix later with the markets WebSocket (`/v1/ws/markets`).
- Kalshi pauses trading Thursdays 3-5 AM ET (`/exchange/status` → `trading_active: false`); its 15m
  markets disappear from the open list then, and cards show the other venues only.
- Venue requests send `User-Agent: onebook-router/0.1`. Polymarket US's CDN throttles Node's default agent.
