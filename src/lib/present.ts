/**
 * Plain-language presentation of specs, tiers and diffs. UI-only; no logic the router depends on.
 */
import type { Diff, Tier } from "@/lib/matcher";
import type { PayoutSpec } from "@/lib/spec";
import type { Listing, VenueId } from "@/lib/venues/types";

export const ASSET: Record<string, { name: string; symbol: string; color: string }> = {
  BTC: { name: "Bitcoin", symbol: "₿", color: "#f7931a" },
  ETH: { name: "Ethereum", symbol: "Ξ", color: "#627eea" },
  SOL: { name: "Solana", symbol: "◎", color: "#14b8a6" },
};
export const assetInfo = (a: string) => ASSET[a] ?? { name: a, symbol: a.slice(0, 1), color: "#888" };

export const VENUE: Record<VenueId, { name: string; short: string; color: string }> = {
  polymarket: { name: "Polymarket", short: "PM", color: "#2e5cff" },
  kalshi: { name: "Kalshi", short: "K", color: "#00b386" },
  hyperliquid: { name: "Hyperliquid", short: "HL", color: "#7ee2c8" },
};

const ORACLE: Record<string, string> = {
  "chainlink-twap-60s": "Chainlink 60s TWAP",
  "chainlink-data-stream": "Chainlink price stream",
  "cf-benchmarks-rti": "CF Benchmarks index",
  "hyperliquid-mark": "Hyperliquid mark price",
  "binance-candle": "Binance candle close",
};
export const oracleName = (o: string) => ORACLE[o] ?? o;

export const fmtClock = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
export const fmtDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
export const fmtUsd = (n: number) =>
  n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: n >= 1000 ? 0 : 2 });
export const fmtCents = (p?: number) => (p === undefined || Number.isNaN(p) ? "–" : `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}¢`);

export interface MarketCopy {
  title: string;
  subtitle: string;
  question: string;
  yes: string;
  no: string;
}

export function marketCopy(spec: PayoutSpec): MarketCopy {
  switch (spec.kind) {
    case "price-compare": {
      const a = assetInfo(spec.end.asset).name;
      return {
        title: `${a} Up or Down`,
        subtitle: `${fmtClock(spec.start.at)} – ${fmtClock(spec.end.at)}`,
        question: `Will ${a} be higher at ${fmtClock(spec.end.at)} than at ${fmtClock(spec.start.at)}?`,
        yes: "Up",
        no: "Down",
      };
    }
    case "price-threshold": {
      const a = assetInfo(spec.ref.asset).name;
      const strike = `$${spec.strike.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
      return {
        title: `${a} ${spec.cmp === ">" ? "above" : "at or above"} ${strike}`,
        subtitle: `${fmtDay(spec.ref.at)}, ${fmtClock(spec.ref.at)}`,
        question: `Will ${a} be ${spec.cmp === ">" ? "above" : "at or above"} ${strike} at ${fmtClock(spec.ref.at)} on ${fmtDay(spec.ref.at)}?`,
        yes: "Yes",
        no: "No",
      };
    }
    case "event":
      return { title: spec.proposition, subtitle: fmtDay(spec.cutoff), question: spec.proposition, yes: "Yes", no: "No" };
  }
}

export const TIER_COPY: Record<Tier, { label: string; tone: "ok" | "warn" | "muted"; explain: string }> = {
  equivalent: {
    label: "Identical payout",
    tone: "ok",
    explain: "These markets pay out under exactly the same conditions, so your order can be split freely.",
  },
  "near-equivalent": {
    label: "Different price sources",
    tone: "warn",
    explain:
      "Same question and time window, but the venues read the price from different sources. In a very close call they could settle differently.",
  },
  related: {
    label: "Not the same bet",
    tone: "muted",
    explain: "These markets look alike but pay out under different conditions, so onebook will not combine them.",
  },
};

/** One readable line per spec difference. Start/end diffs with the same values are merged by the caller. */
export function diffLine(d: Diff, a: VenueId, b: VenueId): string {
  const field = d.field.split(".").pop();
  const A = VENUE[a].name;
  const B = VENUE[b].name;
  switch (field) {
    case "oracle":
      return `Price source: ${A} uses ${oracleName(d.a)}, ${B} uses ${oracleName(d.b)}.`;
    case "aggregation":
      return `Price averaging: ${A} ${aggText(d.a)}, ${B} ${aggText(d.b)}.`;
    case "at":
      return `Settlement time differs: ${fmtClock(d.a)} vs ${fmtClock(d.b)}.`;
    case "strike":
      return `Target price differs: $${d.a} vs $${d.b}.`;
    case "cmp":
      return `Boundary differs: "${d.a === ">=" ? "at or above" : "above"}" vs "${d.b === ">=" ? "at or above" : "above"}".`;
    case "kind":
      return "Different kinds of market (up/down vs price target).";
    default:
      return `${d.field}: ${d.a} vs ${d.b}`;
  }
}

function aggText(json: string): string {
  try {
    const a = JSON.parse(json) as { kind: string; seconds?: number; anchor?: string };
    if (a.kind === "point") return "uses a single price";
    if (a.anchor === "trailing") return `averages the ${a.seconds}s before the time`;
    return `averages ${a.seconds}s (window not stated)`;
  } catch {
    return json;
  }
}

/** Dedupe diff lines (start.oracle and end.oracle usually say the same thing). */
export function diffLines(diffs: Diff[], a: Listing, b: Listing): string[] {
  return [...new Set(diffs.map((d) => diffLine(d, a.venue, b.venue)))];
}
