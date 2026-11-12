# onebook

**A prediction-market router that matches markets on how they pay out, not on what they are called.**
Built at NEAR HACKATHON (2026-11-01 → 2026-11-14) for the `defi` track.

## Problem

The same question trades on several prediction markets at once (Polymarket, Kalshi, Hyperliquid HIP-4, …),
each with its own order book. Liquidity is fragmented, so a trader gets a worse price than the combined
books could give them.

The obvious fix, "aggregate markets with the same title", is unsafe. Markets about the same event often
**resolve differently**: different oracle, different averaging window, `>` vs `>=`, different cutoff
time or timezone, different handling of edge cases. Splitting an order across two such markets can lose
on both legs.

## What onebook does

1. **Pulls live markets** from each venue through a venue adapter.
2. **Extracts a `PayoutSpec`** from each market's rules: what is measured, by which oracle, how it is
   averaged, when, and against what. Markets whose rules text is not recognised get no spec and are
   never routed.
3. **Compares specs** and classifies every cross-venue pair:
   - **Equivalent**: identical payout. Routed freely.
   - **Near-equivalent**: same proposition, but something that could flip the outcome differs (e.g. the
     oracle). Routed only after the user explicitly accepts the listed differences.
   - **Related**: same asset and time, different payout. Never routed together.
4. **Quotes a route**: spends a budget across the live order books of fungible markets, cheapest first,
   including fees and venue minimum order sizes, and compares the result with the best single venue.
5. **Settles through NEAR** *(in progress, see Status)*: the user pays in whatever token they hold. NEAR
   Intents swaps it into the venue's collateral and delivers it to an address **derived from the user's
   NEAR account via Chain Signatures**. The same NEAR account signs the venue order through the MPC
   network, so the position is owned by the user's NEAR account and onebook never holds funds.

### A real example (captured 2026-11-11)

Polymarket "Bitcoin Up or Down, 6:00–6:15 PM ET" and Kalshi "BTC price up in next 15 mins?" cover the
same 15-minute window with the same `>=` comparison. onebook still classifies them as
**near-equivalent**, because:

| | Polymarket | Kalshi |
|---|---|---|
| Oracle | Chainlink BTC/USD TWAP-60s stream | CF Benchmarks BRTI |
| Averaging | 60s TWAP, window position not stated | Simple average of the 60s *before* the time |

When BTC barely moves in a window, these two markets can resolve in opposite directions.

## Status

| Component | State |
|---|---|
| Venue adapters: Polymarket, Kalshi (live, read-only) | ✅ done |
| Venue adapter: Polymarket US (CFTC-regulated), 15m BTC/ETH/SOL up/down | ✅ done; matches Kalshi as **equivalent** (same CF Benchmarks 60s rule) |
| Venue adapter: Hyperliquid HIP-4 (read-only) | ✅ written; not yet verified against the live API |
| Spec extractors: 15m up/down (BTC/ETH/SOL), Kalshi daily thresholds, HIP-4 `priceBinary` | ✅ done, unit-tested on real responses |
| Matcher (equivalent / near-equivalent / related) | ✅ done, unit-tested |
| Router quote (split across books, fees, minimums) | ✅ done, unit-tested |
| Web UI: market cards, trade panel with live split quotes, light/dark, mobile bottom sheet | ✅ done |
| Chain Signatures: derive the user's EVM address from their NEAR account (`/api/near/address`) | ✅ done, checked against `v1.signer` |
| Connect wallet (NEAR Mobile, HOT, Meteor, … via `@hot-labs/near-connect`) | ✅ done |
| Chain Signatures: MPC-signed Polymarket V2 order, verified to recover to the user's address (`/sign-test`) | ✅ verified on mainnet: [tx `BoZABTss…gBE2`](https://nearblocks.io/txns/BoZABTssdxRisVA7g9LGwyXAtADBjcvNW9QFFWnYgBE2), 0.00085 NEAR gas |
| NEAR Intents (1Click): NEAR → USDC on Polygon, delivered to the user's derived address | ✅ built; live quotes and deposit transactions verified; first mainnet swap pending |
| Execution queue: SQLite state machine + worker (`src/lib/orders`) | ✅ done, unit-tested (happy path, refund, expiry, bad signature, limits) |
| Connect your own Kalshi / Polymarket US account (API key held only in your browser) and place live split orders (`src/lib/live`) | ✅ built, unit-tested; off by default, $10 cap; first live run pending |
| Live order submission to Polymarket (international), Hyperliquid | 🚫 dry run only (see Compliance) |

## Try it

Requires Node.js 22.5+ (the order queue uses the built-in `node:sqlite`).

```sh
npm install
npm run dev            # http://localhost:3000
npm test               # unit tests for extractors, matcher, router
```

1. Open http://localhost:3000. Each card is one bet that onebook found on more than one venue, e.g.
   **Bitcoin Up or Down, 7:45 PM – 8:00 PM**. Each card shows the implied chance, the cheapest **Up** and
   **Down** prices across venues (read from the live order books), a countdown, the venues it trades on,
   and a badge saying how well they match. "Different price sources" is the near-equivalent tier.
2. Click **Up** or **Down**. A trade panel opens: a side panel on desktop, a bottom sheet on phones.
   For near-equivalent markets it explains the difference in plain words ("Polymarket uses Chainlink 60s
   TWAP, Kalshi uses CF Benchmarks index") and shows no route until you tick *"I understand and want to
   combine these venues"*.
3. Enter an amount, or use the +$5 / +$25 / +$100 chips. The panel re-quotes against live order books
   and shows the average price, shares, **To win**, how the order splits across venues, and how much more
   it pays than the best single venue. *How this market settles* shows each venue's own rules text.
4. Tick **Show non-combinable** to also see markets onebook refuses to combine (badge
   "Not the same bet"). Their buttons are disabled.
5. Open http://localhost:3000/sign-test, click **Connect wallet**, then **Sign a test order**. Your wallet
   asks you to approve one transaction to `v1.signer`: 1 yoctoNEAR attached, up to 300 TGas prepaid,
   and unused gas refunded. After it lands, the page shows **✓ Valid: the order was signed by your
   address** and links to the NEAR transaction. The order uses a placeholder token id and is never sent
   to Polymarket.
6. **Execute (spends real NEAR, capped at $10):** connect a wallet, open a market, enter up to $10, then
   click **Buy Up · $5 on Polymarket**. A step tracker appears:
   1. **Sign order:** your wallet approves one `v1.signer.sign` call. The Polymarket V2 order (maker = your
      derived Polygon address, limit price from the live book, sized from the swap's guaranteed minimum)
      is signed by your NEAR account through Chain Signatures. No funds move yet.
   2. **Deposit:** after a separate click, your wallet approves one `wrap.near` transaction
      (`storage_deposit` → `near_deposit` → `ft_transfer` to the 1Click deposit address).
   3. **Swap:** the queue polls 1Click until `SUCCESS` (about 30 s). The USDC lands at your own Polygon
      address. A failed swap is refunded to your NEAR account.
   4. **Order (dry run):** the queue reads your USDC balance on Polygon, confirms the order is funded and
      signed, and records the exact payload it would post. It does not post it (see Compliance).

   Links to the NEAR Intents Explorer and Polygonscan appear under the tracker.

API, if you prefer curl:

```sh
curl -s 'localhost:3000/api/near/address?account=example.near'   # EVM address owned by that NEAR account
curl -s localhost:3000/api/markets | jq '.groups[] | {key, bestTier}'
curl -s -X POST localhost:3000/api/quote -H 'Content-Type: application/json' -d '{
  "markets": [{"venue":"polymarket","marketId":"<conditionId>"},{"venue":"kalshi","marketId":"<ticker>"}],
  "side": "yes", "budgetUsd": 50, "allowNearEquivalent": true }'
```

Execution API: `POST /api/orders` (prepare, returns the two NEAR transactions), `POST
/api/orders/:id/signed`, `POST /api/orders/:id/deposited`, `GET /api/orders/:id` (state, event log).
Configuration: see `.env.example`.

`/api/quote` re-fetches the markets and re-checks every pair on the server. It answers `422` for
related pairs, and for near-equivalent pairs unless `allowNearEquivalent` is `true`.

### Live split orders (Kalshi + Polymarket US, your own accounts)

Both venues are CFTC-regulated and list the same 15-minute up/down markets, settled on the same CF Benchmarks
60-second average, so onebook routes across them without any opt-in. Each user connects their own accounts:

1. The server operator sets `ONEBOOK_LIVE_ORDERS=on` (see `.env.example`).
2. The user needs a verified, funded account on [Kalshi](https://kalshi.com) and/or Polymarket US (identity
   verification in its app) and an API key for each (Kalshi: Account & security → API keys; Polymarket US:
   polymarket.us/developer).
3. In the trade panel, **Trade live with your accounts → Connect API key**. The key is imported into the
   browser as a non-exportable key and checked with a balance read. **It never reaches onebook's server.**
4. **Review live order** shows the exact orders (venue, contracts, limit price). Tick the confirmation and
   **Place live orders** (max $10). The browser signs each order. Polymarket US orders go straight from the
   browser to Polymarket US. Kalshi does not accept signed requests from browsers, so onebook's server
   relays the browser-signed Kalshi order, and only the order body it planned for that leg.
5. Each leg is fill-or-kill at its limit price: it fills completely at that price or better, or not at all.
   Legs are independent, so one can fill while the other is killed. The panel says so; nothing is retried
   or unwound automatically.

Polymarket US also runs a partner program for software vendors (in-app identity checks, accounts created
automatically). If onebook joins it, that becomes the default; connecting your own key stays as an option.

## How NEAR fits

- **NEAR Intents (1Click API):** turns any token the user holds into the collateral each venue settles in,
  on that venue's chain, in one step, with an automatic refund if the swap cannot settle.
- **Chain Signatures:** gives every NEAR account its own address on each venue's chain. Positions sit at
  that address and only the user's NEAR account can sign for it. One NEAR account can hold positions on
  every venue without separate wallets.

## Compliance

The author is in the US, where Polymarket's international exchange and Hyperliquid are not available for
opening positions. onebook therefore **reads** public market data from them but does not submit orders
(dry run). Live orders go only to CFTC-regulated venues (Kalshi, Polymarket US), from each user's own
verified account with their own API key, held only in their browser. onebook never holds venue credentials
or funds. Offering this publicly still needs legal review (e.g. introducing-broker rules, venue API terms). It does not help anyone get around a venue's geographic restrictions: a live deployment must
enforce each venue's restrictions, as the venues themselves do (for example Polymarket's
`/api/geoblock` check). This is software, not legal advice.

## Repository map

```
src/lib/spec.ts            PayoutSpec types: the venue-independent payout model
src/lib/extractors/*.ts    rules text → PayoutSpec, one file per venue (pure, tested)
src/lib/venues/*.ts        venue adapters (listing, order books, fees) + registry
src/lib/live/*             live orders on regulated venues: browser-held keys, planning, Kalshi relay
src/lib/matcher.ts         compareSpecs / matchListings → tiers + diffs
src/lib/router.ts          planRoute: split a budget across fungible books
src/lib/near/chainsig.ts   Chain Signatures: MPC contract, EVM address derivation (server)
src/lib/near/mpc.ts        MPC `sign` transaction + signature conversion (browser-safe)
src/lib/near/wrap.ts       NEAR deposit transaction for a 1Click quote (wrap + transfer)
src/lib/intents/oneclick.ts  NEAR Intents 1Click API client
src/lib/orders/*           execution queue: state machine, SQLite store, worker (src/instrumentation.ts)
src/lib/polymarket/order.ts  Polymarket CLOB V2 EIP-712 order
src/components/Wallet*.tsx connect-wallet provider and button
src/app/api/*              /api/markets, /api/quote
src/app/page.tsx           UI
tests/                     vitest, fixtures from real API responses
docs/ARCHITECTURE.md       design, including the execution queue and Chain Signatures flow
AGENTS.md                  instructions for AI coding agents working in this repo
```

## Hackathon disclosures

- All code was written during the hackathon window, starting 2026-11-11. There is no pre-existing code
  or baseline.
- Scaffolded with `create-next-app` (Next.js 15, React 19). Tests use Vitest.
- Code written with AI assistance (Claude Code).
- Market data: Polymarket Gamma and CLOB public APIs, Polymarket US gateway, Kalshi trade-api v2 public
  endpoints, Hyperliquid `/info`.
- The author has no other hackathon project.

## License

MIT, see `LICENSE`.
