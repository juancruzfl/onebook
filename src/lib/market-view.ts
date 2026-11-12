/**
 * Turns /api/markets groups into the "one card per market" view the UI shows.
 * Pure and browser-safe.
 */
import type { Diff, Tier } from "@/lib/matcher";
import type { PayoutSpec } from "@/lib/spec";
import type { Listing, Side, VenueId } from "@/lib/venues/types";

export interface GroupDto {
  key: string;
  listings: Listing[];
  pairs: { a: Listing; b: Listing; tier: Tier; diffs: Diff[] }[];
  bestTier: Tier;
}

export interface MarketView {
  key: string;
  asset: string;
  spec: PayoutSpec;
  closeTime: string;
  /** One listing per venue, all pairwise routable (never "related"). */
  listings: Listing[];
  /** Worst tier among the chosen listings. "related" means nothing can be combined. */
  tier: Tier;
  /**
   * Largest subset of `listings` (2+) whose pairs are all `equivalent`, else empty. Quoted by default without
   * any opt-in; the rest of `listings` is only added after the user accepts the differences.
   */
  core: Listing[];
  /** Tier shown on the card: "equivalent" when a core exists, otherwise `tier`. */
  badgeTier: Tier;
  pairs: GroupDto["pairs"];
  best: Record<Side, { price: number; venue: VenueId } | null>;
}

const rank: Record<Tier, number> = { equivalent: 0, "near-equivalent": 1, related: 2 };
const id = (l: Listing) => `${l.venue}:${l.marketId}`;

function assetOf(spec: PayoutSpec): string {
  return spec.kind === "price-compare" ? spec.end.asset : spec.kind === "price-threshold" ? spec.ref.asset : "EVENT";
}

export function toMarketView(g: GroupDto): MarketView | null {
  const tierOf = new Map<string, Tier>();
  for (const p of g.pairs) {
    tierOf.set(`${id(p.a)}|${id(p.b)}`, p.tier);
    tierOf.set(`${id(p.b)}|${id(p.a)}`, p.tier);
  }
  // Greedy: keep a listing if it is on a new venue and routable with everything kept so far.
  const chosen: Listing[] = [];
  for (const l of g.listings) {
    if (!l.spec || chosen.some((c) => c.venue === l.venue)) continue;
    if (chosen.every((c) => (tierOf.get(`${id(c)}|${id(l)}`) ?? "related") !== "related")) chosen.push(l);
  }
  if (chosen.length === 0) return null;

  const ids = new Set(chosen.map(id));
  const pairs = g.pairs.filter((p) => ids.has(id(p.a)) && ids.has(id(p.b)));
  const tier: Tier =
    chosen.length < 2 ? "related" : pairs.reduce<Tier>((w, p) => (rank[p.tier] > rank[w] ? p.tier : w), "equivalent");

  const core = equivalentCore(chosen, tierOf);
  const badgeTier: Tier = core.length >= 2 ? "equivalent" : tier;

  // Card prices come from what is quoted by default: the equivalent core if there is one.
  const priced = core.length >= 2 ? core : chosen;
  const best = { yes: null, no: null } as MarketView["best"];
  for (const side of ["yes", "no"] as const)
    for (const l of priced) {
      const p = l.preview?.[side];
      if (p !== undefined && p > 0 && p < 1 && (!best[side] || p < best[side]!.price)) best[side] = { price: p, venue: l.venue };
    }

  const spec = chosen[0].spec!;
  return { key: g.key, asset: assetOf(spec), spec, closeTime: chosen[0].closeTime, listings: chosen, tier, core, badgeTier, pairs, best };
}

/** Brute force over subsets (a handful of venues at most): the largest all-equivalent set of 2+. */
function equivalentCore(ls: Listing[], tierOf: Map<string, Tier>): Listing[] {
  let bestSet: Listing[] = [];
  for (let mask = 1; mask < 1 << ls.length; mask++) {
    const set = ls.filter((_, i) => mask & (1 << i));
    if (set.length < 2 || set.length <= bestSet.length) continue;
    const ok = set.every((a, i) => set.slice(i + 1).every((b) => tierOf.get(`${id(a)}|${id(b)}`) === "equivalent"));
    if (ok) bestSet = set;
  }
  // Keep the original (venue) order.
  return ls.filter((l) => bestSet.includes(l));
}

/** Implied chance of YES from the cheapest YES and NO prices (midpoint), 0-100. */
export function chance(m: MarketView): number | null {
  const y = m.best.yes?.price;
  const n = m.best.no?.price;
  if (y !== undefined && n !== undefined) return Math.round(((y + (1 - n)) / 2) * 100);
  if (y !== undefined) return Math.round(y * 100);
  if (n !== undefined) return Math.round((1 - n) * 100);
  return null;
}
