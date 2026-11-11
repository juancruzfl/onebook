import type { Level, Listing, Side, VenueId } from "@/lib/venues/types";

export interface BookInput {
  listing: Listing;
  asks: Level[]; // cheapest first
  /** Taker fee in USD for buying `shares` at `price` on this venue. */
  takerFee: (shares: number, price: number) => number;
}

export interface Allocation {
  venue: VenueId;
  marketId: string;
  shares: number;
  cost: number; // USD incl. fees
  fees: number;
  avgPrice: number; // cost / shares
  /** Worst price level touched; becomes the signed limit price. */
  limitPrice: number;
}

export interface RoutePlan {
  side: Side;
  budgetUsd: number;
  allocations: Allocation[];
  totalShares: number;
  totalCost: number;
  avgPrice: number;
  /** Best result achievable on any single venue, for comparison. */
  bestSingleVenue: { venue: VenueId; shares: number; avgPrice: number } | null;
  /** Extra payout ($) the split earns vs. the best single venue, if both spend the budget. */
  improvementUsd: number;
}

const EPS = 1e-9;

/** Greedy fill: spend `budget` across the given books, cheapest effective price first. */
function fill(books: BookInput[], budget: number): Allocation[] {
  type Cand = { b: number; price: number; size: number; feePerShare: number };
  const cands: Cand[] = [];
  books.forEach((book, b) => {
    for (const l of book.asks) {
      if (l.size <= 0 || l.price <= 0 || l.price >= 1) continue;
      cands.push({ b, price: l.price, size: l.size, feePerShare: book.takerFee(1, l.price) });
    }
  });
  cands.sort((x, y) => x.price + x.feePerShare - (y.price + y.feePerShare));

  const acc = books.map(() => ({ shares: 0, cost: 0, fees: 0, limit: 0 }));
  let left = budget;
  for (const c of cands) {
    if (left <= EPS) break;
    const unit = c.price + c.feePerShare;
    const take = Math.min(c.size, left / unit);
    if (take <= EPS) continue;
    const a = acc[c.b];
    a.shares += take;
    a.cost += take * unit;
    a.fees += take * c.feePerShare;
    a.limit = Math.max(a.limit, c.price);
    left -= take * unit;
  }

  return acc
    .map((a, i) => ({
      venue: books[i].listing.venue,
      marketId: books[i].listing.marketId,
      shares: a.shares,
      cost: a.cost,
      fees: a.fees,
      avgPrice: a.shares > 0 ? a.cost / a.shares : 0,
      limitPrice: a.limit,
    }))
    .filter((a) => a.shares > EPS);
}

function meetsMin(alloc: Allocation, listing: Listing): boolean {
  const m = listing.minOrder;
  if (!m) return true;
  if (m.shares !== undefined && alloc.shares + EPS < m.shares) return false;
  if (m.notionalUsd !== undefined && alloc.cost + EPS < m.notionalUsd) return false;
  return true;
}

/**
 * Plan how to spend `budgetUsd` on the `side` leg across fungible markets.
 * Callers MUST only pass listings the matcher deemed routable together.
 * Venues whose share would fall below their minimum order are dropped and the budget refilled.
 */
export function planRoute(books: BookInput[], side: Side, budgetUsd: number): RoutePlan {
  let active = books.slice();
  let allocations: Allocation[] = [];
  for (let i = 0; i <= books.length; i++) {
    allocations = fill(active, budgetUsd);
    const tooSmall = allocations.filter(
      (a) => !meetsMin(a, active.find((b) => b.listing.venue === a.venue && b.listing.marketId === a.marketId)!.listing),
    );
    if (tooSmall.length === 0) break;
    // Drop the smallest offender and retry.
    const worst = tooSmall.sort((x, y) => x.cost - y.cost)[0];
    active = active.filter((b) => !(b.listing.venue === worst.venue && b.listing.marketId === worst.marketId));
    allocations = [];
  }

  const totalShares = allocations.reduce((s, a) => s + a.shares, 0);
  const totalCost = allocations.reduce((s, a) => s + a.cost, 0);

  let bestSingleVenue: RoutePlan["bestSingleVenue"] = null;
  for (const b of books) {
    const [a] = fill([b], budgetUsd);
    if (!a || !meetsMin(a, b.listing)) continue;
    if (!bestSingleVenue || a.shares > bestSingleVenue.shares)
      bestSingleVenue = { venue: a.venue, shares: a.shares, avgPrice: a.avgPrice };
  }

  return {
    side,
    budgetUsd,
    allocations,
    totalShares,
    totalCost,
    avgPrice: totalShares > 0 ? totalCost / totalShares : 0,
    bestSingleVenue,
    // Each share pays $1 on a win, so extra shares = extra payout in USD.
    improvementUsd: bestSingleVenue ? totalShares - bestSingleVenue.shares : totalShares,
  };
}
