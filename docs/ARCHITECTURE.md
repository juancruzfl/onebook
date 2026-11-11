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

## Execution (planned)

### Custody model

The user's NEAR account owns every position. On each venue's chain the position sits at an address
derived with Chain Signatures from `(NEAR account, path)`. onebook never has custody of funds.

### Flow (Polymarket shown; other EVM venues are the same)

```
1. QUOTED            router plan with limit prices and expiry
2. USER SIGNS        a) deposit to the 1Click deposit address (NEAR wallet tx)
                     b) the venue order (EIP-712) via the MPC signer: maker = derived address,
                        price ≤ limit, expiry = quote deadline. Signed BEFORE money moves.
3. AWAITING_DEPOSIT  queue polls the 1Click status endpoint
   ├─ refunded  → SWAP_FAILED (1Click returns funds to the refund address)
   └─ success   → SWAP_SETTLED (collateral is at the user's derived address)
4. ORDER_SUBMITTED   queue posts the pre-signed order (fill-or-kill at the limit)
   ├─ filled    → FILLED
   └─ not filled→ retry until expiry → EXPIRED (collateral stays at the user's own address)
```

Why this handles atomicity: the swap leg refunds itself if it fails, and the order leg can only fill at
or below the price the user signed. In the worst case the user holds collateral at an address they
control. There is no state in which onebook holds user funds.

### Queue

- An `orders` table with one row per routed order: state, 1Click deposit address, the pre-signed order,
  expiry, retry count, timestamps.
- A worker loop runs every few seconds, picks up rows not yet in a final state, and does the next step.
  It survives restarts because all state is in the table.
- Hackathon scale: SQLite plus a single Node worker. No message broker.

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

- Fees: Kalshi's published formula is modelled without per-order rounding. Polymarket and Hyperliquid
  fees are treated as 0 (TODO verify).
- The Hyperliquid adapter is written against third-party docs. The live endpoint was unreachable from
  the dev machine when it was written.
- Polymarket's 2026 TWAP wording does not say where the 60s window sits. It is modelled as
  `anchor: "unspecified"`, which keeps BTC pairs at near-equivalent even if the oracles were the same.
- Market previews in the UI come from listing endpoints. Only `/api/quote` reads live books.
