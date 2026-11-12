# AGENTS.md

Instructions for AI coding agents (Claude Code, Codex, …) working in this repository. Read
`README.md` for the product and `docs/ARCHITECTURE.md` for the design before changing code.

## Project in one paragraph

onebook is a prediction-market router (Next.js 15 + TypeScript). It reads markets from several venues,
turns each market's rules text into a venue-independent `PayoutSpec`, and only routes orders across
markets whose specs say they pay out the same way. Settlement is planned through NEAR Intents and
Chain Signatures, so positions belong to the user's NEAR account. It is a NEAR HACKATHON project;
development ends 2026-11-14T23:59Z.

## Commands

```sh
npm install
npm run dev        # http://localhost:3000
npm test           # vitest (tests/**/*.test.ts)
npm run typecheck  # tsc --noEmit
npm run lint
npm run build
```

Run `npm test && npm run typecheck && npm run lint` before you call a change done.

## Layout and boundaries

- `src/lib/spec.ts`: the payout model. Changing it affects every venue, so keep it backwards compatible.
- `src/lib/extractors/<venue>.ts`: **pure** functions from raw venue JSON to `ExtractResult`. No network
  calls.
- `src/lib/venues/<venue>.ts`: adapters (HTTP, order books, fees). Register them in
  `src/lib/venues/index.ts`.
- `src/lib/matcher.ts`, `src/lib/router.ts`: **pure** and **venue-agnostic**. Never import a specific
  venue here and never branch on `venue`.
- `src/app/api/*`: thin handlers. `/api/quote` must re-validate fungibility on the server.
- `tests/`: vitest. `tests/fixtures.ts` holds trimmed **real** API responses. When you add an extractor,
  add a real fixture and tests for both acceptance and rejection.

## Two execution modes

- **International (NEAR-native):** on-chain venues, addresses derived from the NEAR account via Chain Signatures,
  funded ahead of time through NEAR Intents (`src/lib/orders`, `src/lib/funding`, `src/lib/withdraw`).
- **US (connected accounts):** regulated venues (Kalshi, Polymarket US), the user's own accounts and API keys
  held in their browser (`src/lib/live`).

Matching and routing are shared. Never mix the two in one order, and never route a user to a venue their
location does not allow.

## Rules that must not be broken

1. **Fail closed.** If an extractor does not recognise a market's rules wording, it returns
   `{ ok: false }`. Never guess a spec, and never route a market without a spec.
2. **Routing tiers:** `related` is never routed. `near-equivalent` needs explicit user opt-in
   (`allowNearEquivalent: true`). Do not loosen these checks to make a demo work.
3. **Severities:** anything that changes the payout condition (asset, time, comparator, strike,
   proposition, cutoff) is `blocking`. Anything that can flip edge cases (oracle, averaging, source,
   edge-case rules) is a `warning`.
4. **No custody.** Designs must keep user funds at addresses controlled by the user's NEAR account
   (Chain Signatures). Do not add a pooled or router-held wallet.
5. **Live orders only on regulated venues, only from the user's own accounts, and no
   geo-circumvention.** Polymarket (international) and Hyperliquid stay dry-run (`ORDER_DRY_RUN` is
   final). Live orders (`src/lib/live`) go only to `LIVE_VENUES` (Kalshi, Polymarket US: CFTC-regulated),
   from each user's own account with the user's own API keys, behind `ONEBOOK_LIVE_ORDERS=on`,
   `MAX_LIVE_USD` and an explicit review + confirm. **Venue secrets never leave the user's browser**
   (non-extractable WebCrypto keys); the server must never receive, log or store them, and only relays
   bodies it planned itself. Never add a venue to `LIVE_VENUES` without the human's approval, and never
   add proxies, region-hopping hosting or anything else that gets around a venue's geographic restrictions.
6. **Execution order of operations:** the venue order is signed and verified (`AWAITING_SIGNATURE` →
   `AWAITING_DEPOSIT_TX`) before the deposit transaction is ever offered. Every wallet prompt is a
   separate user click. Keep `MAX_ORDER_USD` (server) and `MAX_EXEC_USD` (UI) in sync, and never raise
   the defaults (`MAX_ORDER_USD`, `MAX_FUND_USD`, `MAX_LIVE_USD`) without the human's approval. Funds only move
   between the user's NEAR account, addresses derived from it, and 1Click deposit addresses.
7. **Secrets** live in environment variables (`.env.local`, git-ignored). Never commit keys, API
   credentials, seed phrases or submission payloads.
8. **Never without the human's explicit confirmation:** sign NEAR transactions, spend tokens, place a
   live venue order, deploy to mainnet, push, make the repo public, post on social media, or submit the
   hackathon application.
9. Mark unverified external facts (contract addresses, fee formulas, API shapes taken from third-party
   docs) with `TODO(verify)` and say so in `docs/ARCHITECTURE.md` → Known gaps.

## Conventions

- TypeScript strict. Prefer small pure functions and explicit types over classes.
- Timestamps inside specs are ISO-8601 UTC (`isoUtc()`), so they compare by string equality.
- Prices are dollars per $1 payout (0–1). Sizes are shares (contracts).
- External fetches go through `getJson` (`src/lib/http.ts`): no caching, 10s timeout. One venue failing
  must not break the others (`Promise.allSettled`).
- Keep `README.md`'s Status table and "Try it" steps accurate. AI screeners and judges follow them
  literally.

## Live API notes (verified 2026-11-11)

- Polymarket: `GET https://gamma-api.polymarket.com/events?slug=<asset>-updown-15m-<unix window start>`.
  Book: `GET https://clob.polymarket.com/book?token_id=…`. Gamma can list stale markets as active, so
  filter on `endDate > now`.
- Kalshi: `GET https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXBTC15M&status=open`.
  Book: `/markets/{ticker}/orderbook` returns `orderbook_fp.{yes_dollars,no_dollars}`, which are
  **bids** only. A YES ask is `1 - NO bid`.
- Polymarket US (verified 2026-11-12): public data at `https://gateway.polymarket.us/v1` (`/markets?categories=crypto`,
  `/markets/{slug}/book`), no key. Crypto markets carry `assetPriceTerms` (index, window). One YES instrument
  per market: NO asks are `1 - bids`; buying NO is `ORDER_INTENT_BUY_SHORT` at the YES price. Trading at
  `https://api.polymarket.us/v1/orders`, Ed25519-signed `X-PM-*` headers. 25 req/s per IP; back off on 429.
- Hyperliquid: `POST https://api.hyperliquid.xyz/info` with `{"type":"outcomeMeta"}` or
  `{"type":"l2Book","coin":"#<10*outcome+side>"}`. Not yet verified live.
