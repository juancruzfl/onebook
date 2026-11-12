import { getJson, r4 } from "@/lib/http";
import { extractPolymarketUpDown, polymarketLegs, type GammaMarket } from "@/lib/extractors/polymarket";
import { isoUtc } from "@/lib/spec";
import type { Level, Listing, Side, VenueAdapter } from "@/lib/venues/types";

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";

/** Up/down 15m series. Slugs are `<prefix>-updown-15m-<unix window start>`. */
const UPDOWN_15M = [
  { asset: "BTC", prefix: "btc" },
  { asset: "ETH", prefix: "eth" },
  { asset: "SOL", prefix: "sol" },
] as const;

interface GammaEvent {
  slug: string;
  markets: GammaMarket[];
}

/** Current and next 15-minute window starts (unix seconds). */
export function upcomingWindows(nowMs = Date.now(), count = 2): number[] {
  const start = Math.floor(nowMs / 1000 / 900) * 900;
  return Array.from({ length: count }, (_, i) => start + i * 900);
}

async function listUpDown(): Promise<Listing[]> {
  const slugs = UPDOWN_15M.flatMap((s) => upcomingWindows().map((t) => ({ ...s, slug: `${s.prefix}-updown-15m-${t}` })));
  const results = await Promise.allSettled(
    slugs.map(async (s) => {
      const events = await getJson<GammaEvent[]>(`${GAMMA}/events?slug=${s.slug}`);
      return events.flatMap((e) => e.markets.map((m) => ({ s, m })));
    }),
  );

  const listings: Listing[] = [];
  for (const r of results) {
    if (r.status !== "fulfilled") continue; // a missing window is not fatal
    for (const { s, m } of r.value) {
      if (new Date(m.endDate).getTime() <= Date.now()) continue; // Gamma sometimes lists stale markets as active
      const legs = polymarketLegs(m);
      if (!legs) continue;
      const ex = extractPolymarketUpDown(m, s.asset);
      // Gamma's bestAsk/bestBid are for the first outcome. Buying the other outcome costs 1 - bestBid.
      const outcomes = JSON.parse(m.outcomes) as string[];
      const upFirst = /^up$/i.test(outcomes[0] ?? "");
      const askFirst = m.bestAsk;
      const askSecond = m.bestBid !== undefined && m.bestBid > 0 ? r4(1 - m.bestBid) : undefined;
      listings.push({
        venue: "polymarket",
        marketId: m.conditionId,
        title: m.question,
        url: `https://polymarket.com/event/${s.slug}`,
        spec: ex.ok ? ex.spec : null,
        extractError: ex.ok ? undefined : ex.error,
        legs,
        // Indicative top-of-book asks for display; quotes always read the full book.
        preview: upFirst ? { yes: askFirst, no: askSecond } : { yes: askSecond, no: askFirst },
        minOrder: { shares: m.orderMinSize ?? 5 },
        closeTime: isoUtc(m.endDate),
        rulesText: m.description,
      });
    }
  }
  return listings;
}

interface ClobBook {
  asks: { price: string; size: string }[];
}

export const polymarket: VenueAdapter = {
  id: "polymarket",
  displayName: "Polymarket",
  collateral: { chain: "polygon", asset: "pUSD" }, // CLOB V2 collateral (USDC-backed). TODO(verify) contract address
  listMarkets: listUpDown,
  async getAsks(listing: Listing, side: Side): Promise<Level[]> {
    const book = await getJson<ClobBook>(`${CLOB}/book?token_id=${listing.legs[side]}`);
    return book.asks
      .map((a) => ({ price: r4(Number(a.price)), size: Number(a.size) }))
      .sort((x, y) => x.price - y.price);
  },
  // TODO(verify): some Polymarket market types charge taker fees (CLOB exposes a per-token fee rate). Unmodelled.
  takerFee: () => 0,
};
