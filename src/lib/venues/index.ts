import { hyperliquid } from "@/lib/venues/hyperliquid";
import { kalshi } from "@/lib/venues/kalshi";
import { polymarket } from "@/lib/venues/polymarket";
import { polymarketUs } from "@/lib/venues/polymarket-us";
import type { Listing, VenueAdapter, VenueId } from "@/lib/venues/types";

/** Registry. To add a venue: implement VenueAdapter and add it here. Nothing else changes. */
export const VENUES: Record<VenueId, VenueAdapter> = { polymarket, "polymarket-us": polymarketUs, kalshi, hyperliquid };

export interface VenueStatus {
  venue: VenueId;
  ok: boolean;
  count: number;
  error?: string;
}

/** Fetch listings from every venue. One venue failing never takes down the others. */
export async function listAllMarkets(): Promise<{ listings: Listing[]; status: VenueStatus[] }> {
  const adapters = Object.values(VENUES);
  const results = await Promise.allSettled(adapters.map((a) => a.listMarkets()));
  const listings: Listing[] = [];
  const status: VenueStatus[] = results.map((r, i) => {
    if (r.status === "fulfilled") {
      listings.push(...r.value);
      return { venue: adapters[i].id, ok: true, count: r.value.length };
    }
    return { venue: adapters[i].id, ok: false, count: 0, error: String(r.reason?.message ?? r.reason) };
  });
  return { listings, status };
}
