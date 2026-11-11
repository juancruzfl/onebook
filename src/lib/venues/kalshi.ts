import { getJson, r4 } from "@/lib/http";
import { extractKalshiThreshold, extractKalshiUpDown, type KalshiMarket } from "@/lib/extractors/kalshi";
import { isoUtc, type Asset, type ExtractResult } from "@/lib/spec";
import type { Level, Listing, Side, VenueAdapter } from "@/lib/venues/types";

const API = "https://api.elections.kalshi.com/trade-api/v2";

/** Series onebook can extract. Add a row (and an extractor if the rules template is new) to support more. */
const SERIES: { series: string; asset: Asset; extract: (m: KalshiMarket, a: Asset) => ExtractResult }[] = [
  { series: "KXBTC15M", asset: "BTC", extract: extractKalshiUpDown },
  { series: "KXETH15M", asset: "ETH", extract: extractKalshiUpDown },
  { series: "KXSOL15M", asset: "SOL", extract: extractKalshiUpDown },
  { series: "KXBTCD", asset: "BTC", extract: extractKalshiThreshold },
  { series: "KXETHD", asset: "ETH", extract: extractKalshiThreshold },
];

/** Only list threshold markets closing within this horizon to keep payloads small. */
const HORIZON_MS = 36 * 3600 * 1000;

async function listSeries(series: string): Promise<KalshiMarket[]> {
  const out: KalshiMarket[] = [];
  let cursor = "";
  for (let page = 0; page < 3; page++) {
    const q = new URLSearchParams({ series_ticker: series, status: "open", limit: "1000" });
    if (cursor) q.set("cursor", cursor);
    const res = await getJson<{ markets: KalshiMarket[]; cursor?: string }>(`${API}/markets?${q}`);
    out.push(...res.markets);
    if (!res.cursor) break;
    cursor = res.cursor;
  }
  return out;
}

async function listMarkets(): Promise<Listing[]> {
  const results = await Promise.allSettled(SERIES.map(async (s) => ({ s, markets: await listSeries(s.series) })));
  const listings: Listing[] = [];
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    const { s, markets } = r.value;
    for (const m of markets) {
      if (new Date(m.close_time).getTime() - Date.now() > HORIZON_MS) continue;
      const ex = s.extract(m, s.asset);
      listings.push({
        venue: "kalshi",
        marketId: m.ticker,
        title: `${m.title}${m.yes_sub_title ? ` (${m.yes_sub_title})` : ""}`,
        url: `https://kalshi.com/markets/${s.series.toLowerCase()}`,
        spec: ex.ok ? ex.spec : null,
        extractError: ex.ok ? undefined : ex.error,
        legs: { yes: `${m.ticker}:yes`, no: `${m.ticker}:no` },
        preview: {
          yes: m.yes_ask_dollars ? Number(m.yes_ask_dollars) : undefined,
          no: m.no_ask_dollars ? Number(m.no_ask_dollars) : undefined,
        },
        minOrder: { shares: 1 },
        closeTime: isoUtc(m.close_time),
        rulesText: [m.rules_primary, m.rules_secondary].filter(Boolean).join("\n"),
      });
    }
  }
  return listings;
}

/** Kalshi books list BIDS only, per side, ascending. A YES ask at p is a NO bid at 1 - p. */
interface KalshiBook {
  orderbook_fp?: { yes_dollars?: [string, string][] | null; no_dollars?: [string, string][] | null };
}

export function kalshiAsks(book: KalshiBook, side: Side): Level[] {
  const opposite = side === "yes" ? book.orderbook_fp?.no_dollars : book.orderbook_fp?.yes_dollars;
  return (opposite ?? [])
    .map(([p, s]) => ({ price: r4(1 - Number(p)), size: Number(s) }))
    .filter((l) => l.price > 0 && l.price < 1 && l.size > 0)
    .sort((x, y) => x.price - y.price);
}

export const kalshi: VenueAdapter = {
  id: "kalshi",
  displayName: "Kalshi",
  // Tokenized Kalshi markets trade on Solana via DFlow (Proof KYC required to buy). Read-only here.
  collateral: { chain: "solana", asset: "USDC" },
  listMarkets,
  async getAsks(listing: Listing, side: Side): Promise<Level[]> {
    const book = await getJson<KalshiBook>(`${API}/markets/${listing.marketId}/orderbook`);
    return kalshiAsks(book, side);
  },
  // Kalshi published taker fee: 0.07 * contracts * P * (1 - P), rounded up to the cent per order.
  // Rounding is ignored here. TODO(verify) against the current fee schedule; DFlow may differ.
  takerFee: (shares, price) => 0.07 * shares * price * (1 - price),
};
