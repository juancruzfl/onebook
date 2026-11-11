import { describe, expect, it } from "vitest";
import { compareSpecs, matchListings } from "@/lib/matcher";
import { extractPolymarketUpDown } from "@/lib/extractors/polymarket";
import { extractKalshiThreshold, extractKalshiUpDown } from "@/lib/extractors/kalshi";
import { extractHyperliquidPriceBinary } from "@/lib/extractors/hyperliquid";
import type { PayoutSpec } from "@/lib/spec";
import type { Listing } from "@/lib/venues/types";
import { hlBtcDaily, kalshiBtc15m, kalshiBtcDaily, polyBtc15m } from "./fixtures";

const spec = (r: { ok: boolean; spec?: PayoutSpec }) => {
  if (!r.ok || !r.spec) throw new Error("extraction failed");
  return r.spec;
};
const poly = spec(extractPolymarketUpDown(polyBtc15m, "BTC"));
const kal = spec(extractKalshiUpDown(kalshiBtc15m, "BTC"));

describe("compareSpecs", () => {
  it("identical specs are equivalent", () => {
    expect(compareSpecs(kal, kal)).toEqual({ tier: "equivalent", diffs: [] });
  });

  it("Polymarket vs Kalshi 15m BTC: same window, different oracle => near-equivalent", () => {
    const c = compareSpecs(poly, kal);
    expect(c.tier).toBe("near-equivalent");
    expect(c.diffs.map((d) => d.field).sort()).toEqual(["end.aggregation", "end.oracle", "start.aggregation", "start.oracle"]);
    expect(c.diffs.every((d) => d.severity === "warning")).toBe(true);
  });

  it("different windows are related, never routable", () => {
    const shifted = spec(extractKalshiUpDown({ ...kalshiBtc15m, open_time: "2026-11-11T23:15:00Z", close_time: "2026-11-11T23:30:00Z" }, "BTC"));
    expect(compareSpecs(poly, shifted).tier).toBe("related");
  });

  it("same strike and time but > vs >= and different oracle => related", () => {
    const c = compareSpecs(spec(extractKalshiThreshold(kalshiBtcDaily, "BTC")), spec(extractHyperliquidPriceBinary(hlBtcDaily)));
    expect(c.tier).toBe("related");
    expect(c.diffs.find((d) => d.field === "cmp")?.severity).toBe("blocking");
  });

  it("up/down vs threshold => related", () => {
    expect(compareSpecs(poly, spec(extractKalshiThreshold(kalshiBtcDaily, "BTC"))).tier).toBe("related");
  });

  it("event specs: edge-case differences are warnings, cutoff differences block", () => {
    const base: PayoutSpec = { kind: "event", proposition: "fed-cut-dec-2026", source: "FOMC statement", cutoff: "2026-12-10T19:00:00.000Z", edgeCases: { delayed: "no" } };
    expect(compareSpecs(base, { ...base, edgeCases: { delayed: "void" } }).tier).toBe("near-equivalent");
    expect(compareSpecs(base, { ...base, cutoff: "2026-12-11T05:00:00.000Z" }).tier).toBe("related");
  });
});

describe("matchListings", () => {
  const listing = (venue: Listing["venue"], marketId: string, s: PayoutSpec | null): Listing => ({
    venue, marketId, title: marketId, url: "", spec: s, legs: { yes: "y", no: "n" }, closeTime: "", rulesText: "",
  });

  it("pairs only cross-venue listings in the same bucket and skips unextracted ones", () => {
    const groups = matchListings([
      listing("polymarket", "p1", poly),
      listing("kalshi", "k1", kal),
      listing("kalshi", "k2", null),
      listing("polymarket", "p2", poly), // same venue as p1: not paired with p1
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].pairs.map((p) => `${p.a.marketId}-${p.b.marketId}`).sort()).toEqual(["k1-p2", "p1-k1"]);
  });
});
