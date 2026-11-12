import { describe, expect, it } from "vitest";
import { chance, toMarketView, type GroupDto } from "@/lib/market-view";
import { extractKalshiThreshold, extractKalshiUpDown } from "@/lib/extractors/kalshi";
import { extractPolymarketUpDown } from "@/lib/extractors/polymarket";
import { compareSpecs } from "@/lib/matcher";
import type { PayoutSpec } from "@/lib/spec";
import type { Listing } from "@/lib/venues/types";
import { kalshiBtc15m, kalshiBtcDaily, polyBtc15m } from "./fixtures";

const spec = (r: { ok: boolean; spec?: PayoutSpec }) => r.spec!;
const listing = (venue: Listing["venue"], marketId: string, s: PayoutSpec, preview: Listing["preview"]): Listing => ({
  venue, marketId, title: marketId, url: "", spec: s, legs: { yes: "", no: "" }, closeTime: "2026-11-11T23:15:00.000Z", rulesText: "", preview,
});

const pm = listing("polymarket", "pm", spec(extractPolymarketUpDown(polyBtc15m, "BTC")), { yes: 0.53, no: 0.49 });
const k = listing("kalshi", "k", spec(extractKalshiUpDown(kalshiBtc15m, "BTC")), { yes: 0.55, no: 0.46 });
const ladder = listing("kalshi", "ladder", spec(extractKalshiThreshold(kalshiBtcDaily, "BTC")), { yes: 0.01, no: 1 });
const pair = (a: Listing, b: Listing) => ({ a, b, ...compareSpecs(a.spec!, b.spec!) });

describe("toMarketView", () => {
  it("keeps one routable listing per venue and takes the cheapest price per side", () => {
    const g: GroupDto = { key: "price:BTC:x", listings: [pm, ladder, k], pairs: [pair(pm, ladder), pair(pm, k)], bestTier: "near-equivalent" };
    const m = toMarketView(g)!;
    expect(m.listings.map((l) => l.marketId)).toEqual(["pm", "k"]);
    expect(m.tier).toBe("near-equivalent");
    expect(m.best.yes).toEqual({ price: 0.53, venue: "polymarket" });
    expect(m.best.no).toEqual({ price: 0.46, venue: "kalshi" });
    expect(chance(m)).toBe(54); // midpoint of 53¢ yes and 1 - 46¢
  });

  it("marks a group with nothing combinable as related", () => {
    const g: GroupDto = { key: "price:BTC:y", listings: [pm, ladder], pairs: [pair(pm, ladder)], bestTier: "related" };
    expect(toMarketView(g)!.tier).toBe("related");
  });
});
