import { NextResponse } from "next/server";
import { bestTier, matchListings } from "@/lib/matcher";
import { listAllMarkets } from "@/lib/venues";

export const dynamic = "force-dynamic";

/**
 * GET /api/markets
 * Live listings from every venue, grouped by (asset, settlement time), with every
 * cross-venue pair classified as equivalent / near-equivalent / related.
 */
export async function GET() {
  const { listings, status } = await listAllMarkets();
  const groups = matchListings(listings).map((g) => ({ ...g, bestTier: bestTier(g) }));
  const unextracted = listings
    .filter((l) => !l.spec)
    .map((l) => ({ venue: l.venue, marketId: l.marketId, title: l.title, error: l.extractError }));
  return NextResponse.json({ fetchedAt: new Date().toISOString(), status, groups, unextracted });
}
