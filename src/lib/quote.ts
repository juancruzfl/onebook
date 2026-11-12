/**
 * Server-side route quoting shared by /api/quote and order preparation.
 * Never trusts the client's grouping: re-lists markets and re-compares every pair.
 */
import { compareSpecs, type Comparison } from "@/lib/matcher";
import { planRoute, type RoutePlan } from "@/lib/router";
import { listAllMarkets, VENUES } from "@/lib/venues";
import type { Listing, Side, VenueId } from "@/lib/venues/types";

export interface QuoteInput {
  markets: { venue: VenueId; marketId: string }[];
  side: Side;
  budgetUsd: number;
  allowNearEquivalent?: boolean;
}

export class QuoteError extends Error {
  constructor(
    message: string,
    public status: number,
    public detail?: Comparison,
  ) {
    super(message);
  }
}

export function validateQuoteInput(b: Partial<QuoteInput>): QuoteInput {
  if (!Array.isArray(b.markets) || b.markets.length < 1 || b.markets.length > 5) throw new QuoteError("markets: 1-5 entries", 400);
  if (b.side !== "yes" && b.side !== "no") throw new QuoteError("side: yes|no", 400);
  if (!(typeof b.budgetUsd === "number" && b.budgetUsd > 0 && b.budgetUsd <= 100_000)) throw new QuoteError("budgetUsd: 0-100000", 400);
  return { markets: b.markets, side: b.side, budgetUsd: b.budgetUsd, allowNearEquivalent: !!b.allowNearEquivalent };
}

export async function computeQuote(q: QuoteInput): Promise<{ plan: RoutePlan; listings: Listing[] }> {
  const { listings } = await listAllMarkets();
  const chosen = q.markets.map((m) => listings.find((l) => l.venue === m.venue && l.marketId === m.marketId));
  if (chosen.some((l) => !l)) throw new QuoteError("unknown or closed market", 404);
  const ls = chosen as Listing[];
  if (ls.some((l) => !l.spec)) throw new QuoteError("market has no recognised payout spec; refusing to route", 400);

  for (let i = 0; i < ls.length; i++)
    for (let j = i + 1; j < ls.length; j++) {
      const c = compareSpecs(ls[i].spec!, ls[j].spec!);
      if (c.tier === "related") throw new QuoteError("markets do not pay out the same", 422, c);
      if (c.tier === "near-equivalent" && !q.allowNearEquivalent)
        throw new QuoteError("near-equivalent markets require allowNearEquivalent: true", 422, c);
    }

  const books = await Promise.all(
    ls.map(async (l) => ({ listing: l, asks: await VENUES[l.venue].getAsks(l, q.side), takerFee: VENUES[l.venue].takerFee })),
  );
  return { plan: planRoute(books, q.side, q.budgetUsd), listings: ls };
}
