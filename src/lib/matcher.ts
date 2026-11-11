import type { PayoutSpec, PriceRef } from "@/lib/spec";
import type { Listing } from "@/lib/venues/types";

/**
 * - equivalent: specs are identical; the router may split freely.
 * - near-equivalent: same proposition, but something that can change the outcome
 *   differs (oracle, averaging). Routable only with explicit user opt-in.
 * - related: same asset/time bucket but a different payout. Never routed together.
 */
export type Tier = "equivalent" | "near-equivalent" | "related";

export interface Diff {
  field: string;
  a: string;
  b: string;
  severity: "blocking" | "warning";
}

export interface Comparison {
  tier: Tier;
  diffs: Diff[];
}

const fmt = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

function diffRef(prefix: string, a: PriceRef, b: PriceRef, out: Diff[]) {
  if (a.asset !== b.asset) out.push({ field: `${prefix}.asset`, a: a.asset, b: b.asset, severity: "blocking" });
  if (a.at !== b.at) out.push({ field: `${prefix}.at`, a: a.at, b: b.at, severity: "blocking" });
  if (a.oracle !== b.oracle) out.push({ field: `${prefix}.oracle`, a: a.oracle, b: b.oracle, severity: "warning" });
  if (fmt(a.aggregation) !== fmt(b.aggregation))
    out.push({ field: `${prefix}.aggregation`, a: fmt(a.aggregation), b: fmt(b.aggregation), severity: "warning" });
}

/** Pure, venue-agnostic comparison of two payout specs. */
export function compareSpecs(a: PayoutSpec, b: PayoutSpec): Comparison {
  const diffs: Diff[] = [];

  if (a.kind !== b.kind) {
    diffs.push({ field: "kind", a: a.kind, b: b.kind, severity: "blocking" });
  } else if (a.kind === "price-compare" && b.kind === "price-compare") {
    if (a.cmp !== b.cmp) diffs.push({ field: "cmp", a: a.cmp, b: b.cmp, severity: "blocking" });
    diffRef("end", a.end, b.end, diffs);
    diffRef("start", a.start, b.start, diffs);
  } else if (a.kind === "price-threshold" && b.kind === "price-threshold") {
    if (a.cmp !== b.cmp) diffs.push({ field: "cmp", a: a.cmp, b: b.cmp, severity: "blocking" });
    if (a.strike !== b.strike)
      diffs.push({ field: "strike", a: String(a.strike), b: String(b.strike), severity: "blocking" });
    diffRef("ref", a.ref, b.ref, diffs);
  } else if (a.kind === "event" && b.kind === "event") {
    if (a.proposition !== b.proposition)
      diffs.push({ field: "proposition", a: a.proposition, b: b.proposition, severity: "blocking" });
    if (a.cutoff !== b.cutoff) diffs.push({ field: "cutoff", a: a.cutoff, b: b.cutoff, severity: "blocking" });
    if (a.source !== b.source) diffs.push({ field: "source", a: a.source, b: b.source, severity: "warning" });
    const keys = new Set([...Object.keys(a.edgeCases), ...Object.keys(b.edgeCases)]);
    for (const k of keys) {
      const va = a.edgeCases[k] ?? "unspecified";
      const vb = b.edgeCases[k] ?? "unspecified";
      if (va !== vb) diffs.push({ field: `edgeCases.${k}`, a: va, b: vb, severity: "warning" });
    }
  }

  const tier: Tier = diffs.some((d) => d.severity === "blocking")
    ? "related"
    : diffs.length > 0
      ? "near-equivalent"
      : "equivalent";
  return { tier, diffs };
}

/**
 * Coarse bucket so we only compare markets that could plausibly match.
 * Markets in the same bucket are compared pairwise; the spec comparison decides the tier.
 */
export function bucketKey(spec: PayoutSpec): string {
  switch (spec.kind) {
    case "price-compare":
      return `price:${spec.end.asset}:${spec.end.at}`;
    case "price-threshold":
      return `price:${spec.ref.asset}:${spec.ref.at}`;
    case "event":
      return `event:${spec.cutoff}:${spec.proposition}`;
  }
}

export interface PairComparison extends Comparison {
  a: Listing;
  b: Listing;
}

export interface MatchGroup {
  key: string;
  listings: Listing[];
  /** Every cross-venue pair in the bucket with its tier and reasons. */
  pairs: PairComparison[];
}

/** Group listings into buckets and compare every cross-venue pair. Unextracted listings are skipped. */
export function matchListings(listings: Listing[]): MatchGroup[] {
  const buckets = new Map<string, Listing[]>();
  for (const l of listings) {
    if (!l.spec) continue;
    const key = bucketKey(l.spec);
    const arr = buckets.get(key) ?? [];
    arr.push(l);
    buckets.set(key, arr);
  }

  const groups: MatchGroup[] = [];
  for (const [key, ls] of buckets) {
    const pairs: PairComparison[] = [];
    for (let i = 0; i < ls.length; i++)
      for (let j = i + 1; j < ls.length; j++) {
        if (ls[i].venue === ls[j].venue) continue;
        pairs.push({ a: ls[i], b: ls[j], ...compareSpecs(ls[i].spec!, ls[j].spec!) });
      }
    if (pairs.length > 0) groups.push({ key, listings: ls, pairs });
  }
  return groups.sort((x, y) => x.key.localeCompare(y.key));
}

/** Best tier across a group's pairs, for sorting/badges. */
export function bestTier(group: MatchGroup): Tier {
  const order: Tier[] = ["equivalent", "near-equivalent", "related"];
  return order.find((t) => group.pairs.some((p) => p.tier === t)) ?? "related";
}
