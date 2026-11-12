import { NextResponse } from "next/server";
import { bestTier, matchListings, type MatchGroup } from "@/lib/matcher";
import { listAllMarkets, VENUES } from "@/lib/venues";
import type { Listing } from "@/lib/venues/types";

export const dynamic = "force-dynamic";

/** Related-only groups (nothing combinable) are kept for the "show non-combinable" view, but trimmed. */
const MAX_RELATED_PAIRS = 4;

/** Keep only what the UI needs: routable pairs, or a few related ones as examples. */
function trim(g: MatchGroup): MatchGroup {
  const routable = g.pairs.filter((p) => p.tier !== "related");
  const pairs = routable.length > 0 ? routable : g.pairs.slice(0, MAX_RELATED_PAIRS);
  const keep = new Set(pairs.flatMap((p) => [p.a, p.b]));
  return { ...g, pairs, listings: g.listings.filter((l) => keep.has(l)) };
}

/**
 * Replace listing-endpoint previews with top-of-book asks for listings that can actually be routed,
 * so card prices match what /api/quote will see. Falls back to the listing preview on failure.
 */
async function refreshPreviews(listings: Listing[]): Promise<void> {
  await Promise.allSettled(
    listings.map(async (l) => {
      const [yes, no] = await Promise.all([VENUES[l.venue].getAsks(l, "yes"), VENUES[l.venue].getAsks(l, "no")]);
      l.preview = { yes: yes[0]?.price, no: no[0]?.price };
    }),
  );
}

/**
 * GET /api/markets
 * Live listings from every venue, grouped by (asset, settlement time), with cross-venue pairs
 * classified as equivalent / near-equivalent / related.
 */
export async function GET() {
  const { listings, status } = await listAllMarkets();
  const groups = matchListings(listings).map(trim);

  const routable = new Set<Listing>();
  for (const g of groups) for (const p of g.pairs) if (p.tier !== "related") routable.add(p.a).add(p.b);
  await refreshPreviews([...routable]);

  const unextracted = listings
    .filter((l) => !l.spec)
    .map((l) => ({ venue: l.venue, marketId: l.marketId, title: l.title, error: l.extractError }));
  return NextResponse.json({
    fetchedAt: new Date().toISOString(),
    status,
    groups: groups.map((g) => ({ ...g, bestTier: bestTier(g) })),
    unextracted,
  });
}
