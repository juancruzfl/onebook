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
| Venue adapter: Hyperliquid HIP-4 (read-only) | ✅ written; not yet verified against the live API |
| Spec extractors: 15m up/down (BTC/ETH/SOL), Kalshi daily thresholds, HIP-4 `priceBinary` | ✅ done, unit-tested on real responses |
| Matcher (equivalent / near-equivalent / related) | ✅ done, unit-tested |
| Router quote (split across books, fees, minimums) | ✅ done, unit-tested |
| Web UI + `/api/markets` + `/api/quote` | ✅ done |
| NEAR Intents (1Click) swap to venue collateral | ⏳ next |
| Chain Signatures derived address + MPC-signed venue order | ⏳ next |
| Execution queue (state machine, see `docs/ARCHITECTURE.md`) | ⏳ next |
| Live order submission to venues | 🚫 dry run only (see Compliance) |

## Try it

Requires Node.js 20+.

```sh
npm install
npm run dev            # http://localhost:3000
npm test               # unit tests for extractors, matcher, router
```

1. Open http://localhost:3000. You should see one card per matched group, e.g. *"BTC · settles
   Nov 11, 6:30 PM EST"* with an orange **Near-equivalent** badge, plus the exact differences
   (`end.oracle: chainlink-twap-60s ≠ cf-benchmarks-rti`, …). The chips at the top show how many
   markets each venue returned.
2. Click **Quote a route**, pick a side and a budget, and click **Get route**. The button stays
   disabled until you tick *"I accept the differences above"*, because the pair is only near-equivalent.
3. You get a table with shares, cost, average price and limit price for each venue, plus how much more
   payout the split earns than the best single venue. Nothing is signed or sent.
4. Tick **show related (non-routable) groups** to see pairs onebook refuses to route and the
   differences that block them.

API, if you prefer curl:

```sh
curl -s localhost:3000/api/markets | jq '.groups[] | {key, bestTier}'
curl -s -X POST localhost:3000/api/quote -H 'Content-Type: application/json' -d '{
  "markets": [{"venue":"polymarket","marketId":"<conditionId>"},{"venue":"kalshi","marketId":"<ticker>"}],
  "side": "yes", "budgetUsd": 50, "allowNearEquivalent": true }'
```

`/api/quote` re-fetches the markets and re-checks every pair on the server. It answers `422` for
related pairs, and for near-equivalent pairs unless `allowNearEquivalent` is `true`.

## How NEAR fits

- **NEAR Intents (1Click API):** turns any token the user holds into the collateral each venue settles in,
  on that venue's chain, in one step, with an automatic refund if the swap cannot settle.
- **Chain Signatures:** gives every NEAR account its own address on each venue's chain. Positions sit at
  that address and only the user's NEAR account can sign for it. One NEAR account can hold positions on
  every venue without separate wallets.

## Compliance

The author is in the US, where Polymarket's international exchange and Hyperliquid are not available for
opening positions. onebook therefore **reads** public market data from them but does not submit orders
(dry run). It does not help anyone get around a venue's geographic restrictions: a live deployment must
enforce each venue's restrictions, as the venues themselves do (for example Polymarket's
`/api/geoblock` check). This is software, not legal advice.

## Repository map

```
src/lib/spec.ts            PayoutSpec types: the venue-independent payout model
src/lib/extractors/*.ts    rules text → PayoutSpec, one file per venue (pure, tested)
src/lib/venues/*.ts        venue adapters (listing, order books, fees) + registry
src/lib/matcher.ts         compareSpecs / matchListings → tiers + diffs
src/lib/router.ts          planRoute: split a budget across fungible books
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
- Market data: Polymarket Gamma and CLOB public APIs, Kalshi trade-api v2 public endpoints, Hyperliquid
  `/info`.
- The author has no other hackathon project.

## License

MIT, see `LICENSE`.
