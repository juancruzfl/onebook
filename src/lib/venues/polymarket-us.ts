import { extractPolymarketUsUpDown, type PolymarketUsMarket } from "@/lib/extractors/polymarket-us";
import { getJson, r4 } from "@/lib/http";
import { isoUtc } from "@/lib/spec";
import type { Level, Listing, Side, VenueAdapter } from "@/lib/venues/types";

/** Public market data (no key). Trading uses https://api.polymarket.us (see src/lib/live/venues.ts). */
export const PMUS_GATEWAY = "https://gateway.polymarket.us/v1";

/** Up/down horizons onebook lists. Kalshi only has 15m today, so other horizons would never pair. */
const HORIZONS = new Set(["15m"]);
/** Default (tier 1) taker fee coefficient. The live value per market is `feeCoefficient`. */
export const PMUS_TAKER_THETA = 0.095;

/** GET with the backoff Polymarket US asks for on 429 (25 req/s per IP): wait 1 s, then 2 s. */
async function pmusGet<T>(url: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await getJson<T>(url);
    } catch (e) {
      if (attempt >= 2 || !/HTTP 429/.test((e as Error).message)) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

async function listMarkets(): Promise<Listing[]> {
  const now = Date.now();
  // endDate is the instrument expiry, set 30 min after the settlement instant; filter on the window below.
  const q = new URLSearchParams({
    limit: "200",
    active: "true",
    closed: "false",
    categories: "crypto",
    endDateMin: new Date(now).toISOString(),
    endDateMax: new Date(now + 90 * 60_000).toISOString(),
  });
  const res = await pmusGet<{ markets: PolymarketUsMarket[] }>(`${PMUS_GATEWAY}/markets?${q}`);
  const out: Listing[] = [];
  for (const m of res.markets ?? []) {
    const t = m.assetPriceTerms;
    if (!t || !HORIZONS.has(t.horizon) || new Date(t.windowEnd).getTime() <= now) continue;
    const ex = extractPolymarketUsUpDown(m);
    const price = (long: boolean) => {
      const p = Number(m.marketSides?.find((s) => s.long === long)?.price);
      return p > 0 && p < 1 ? p : undefined;
    };
    out.push({
      venue: "polymarket-us",
      marketId: m.slug,
      title: `${m.title ?? m.question}${m.subtitle ? ` (${m.subtitle})` : ""}`,
      // TODO(verify): public web URL format for a single market.
      url: `https://polymarket.us/market/${m.slug}`,
      spec: ex.ok ? ex.spec : null,
      extractError: ex.ok ? undefined : ex.error,
      // One instrument per market: YES = buy long, NO = sell long (buy short).
      legs: { yes: m.slug, no: m.slug },
      preview: { yes: price(true), no: price(false) },
      minOrder: { shares: m.minimumTradeQty ?? 1 },
      closeTime: isoUtc(t.windowEnd),
      rulesText: m.description,
    });
  }
  return out;
}

interface PmusBook {
  marketData?: {
    state?: string;
    bids?: { px: { value: string }; qty: string }[];
    offers?: { px: { value: string }; qty: string }[];
  };
}

/** The book is for the YES instrument. YES asks are its offers; a NO ask at p is a YES bid at 1 - p. */
export function pmusAsks(book: PmusBook, side: Side): Level[] {
  const md = book.marketData;
  if (!md || (md.state && md.state !== "MARKET_STATE_OPEN")) return [];
  const raw = side === "yes" ? md.offers : md.bids;
  return (raw ?? [])
    .map((l) => {
      const p = Number(l.px.value);
      return { price: side === "yes" ? r4(p) : r4(1 - p), size: Number(l.qty) };
    })
    .filter((l) => l.price > 0 && l.price < 1 && l.size > 0)
    .sort((x, y) => x.price - y.price);
}

export const polymarketUs: VenueAdapter = {
  id: "polymarket-us",
  displayName: "Polymarket US",
  // CFTC-regulated exchange; USD buying power in a KYC'd account. Not an on-chain venue.
  collateral: { chain: "polymarket-us", asset: "USD" },
  listMarkets,
  async getAsks(listing, side) {
    return pmusAsks(await pmusGet<PmusBook>(`${PMUS_GATEWAY}/markets/${listing.marketId}/book`), side);
  },
  // Fee = Θ × C × p × (1 − p), Θ = 0.095 at tier 1 (docs.polymarket.us/fees). Banker's rounding to the cent ignored.
  takerFee: (shares, price) => PMUS_TAKER_THETA * shares * price * (1 - price),
};
