import { describe, expect, it } from "vitest";
import { extractKalshiUpDown } from "@/lib/extractors/kalshi";
import { extractPolymarketUsUpDown } from "@/lib/extractors/polymarket-us";
import { extractPolymarketUpDown } from "@/lib/extractors/polymarket";
import { compareSpecs } from "@/lib/matcher";
import { toMarketView } from "@/lib/market-view";
import type { ExtractResult, PayoutSpec } from "@/lib/spec";
import { pmusAsks } from "@/lib/venues/polymarket-us";
import type { Listing } from "@/lib/venues/types";
import { kalshiBtc15m, pmusBtc15m, polyBtc15m } from "./fixtures";

/** Spec of a result that must have extracted. */
const spec = (r: ExtractResult): PayoutSpec => {
  if (!r.ok) throw new Error(r.error);
  return r.spec;
};

const sameWindowKalshi = { ...kalshiBtc15m, open_time: "2026-11-12T06:45:00Z", close_time: "2026-11-12T07:00:00Z" };
const sameWindowPoly = { ...polyBtc15m, eventStartTime: "2026-11-12T06:45:00Z", endDate: "2026-11-12T07:00:00Z" };

describe("extractPolymarketUsUpDown", () => {
  it("extracts the BRTI 60s-average up/down spec", () => {
    const r = extractPolymarketUsUpDown(pmusBtc15m);
    expect(r.ok).toBe(true);
    const s = spec(r) as Extract<PayoutSpec, { kind: "price-compare" }>;
    expect(s.cmp).toBe(">=");
    expect(s.end).toEqual({
      asset: "BTC",
      oracle: "cf-benchmarks-rti",
      aggregation: { kind: "average", seconds: 60, anchor: "trailing" },
      at: "2026-11-12T07:00:00.000Z",
    });
    expect(s.start.at).toBe("2026-11-12T06:45:00.000Z");
  });

  it("is equivalent to Kalshi for the same window, near-equivalent to Polymarket international", () => {
    const us = spec(extractPolymarketUsUpDown(pmusBtc15m));
    expect(compareSpecs(us, spec(extractKalshiUpDown(sameWindowKalshi, "BTC"))).tier).toBe("equivalent");
    expect(compareSpecs(us, spec(extractPolymarketUpDown(sameWindowPoly, "BTC"))).tier).toBe("near-equivalent");
  });

  it("fails closed on changed wording, source mismatch or unknown assets", () => {
    const d = pmusBtc15m.description;
    expect(extractPolymarketUsUpDown({ ...pmusBtc15m, description: d.replace("greater than or equal to", "greater than") }).ok).toBe(false);
    expect(extractPolymarketUsUpDown({ ...pmusBtc15m, description: d.replace("simple average", "median") }).ok).toBe(false);
    expect(
      extractPolymarketUsUpDown({ ...pmusBtc15m, assetPriceTerms: { ...pmusBtc15m.assetPriceTerms!, indexSymbol: "ETHUSD_RTI" } }).ok,
    ).toBe(false);
    expect(
      extractPolymarketUsUpDown({
        ...pmusBtc15m,
        assetPriceTerms: { ...pmusBtc15m.assetPriceTerms!, asset: { assetClass: "ASSET_CLASS_CRYPTO", symbol: "doge" } },
      }).ok,
    ).toBe(false);
    expect(extractPolymarketUsUpDown({ ...pmusBtc15m, assetPriceTerms: null }).ok).toBe(false);
  });
});

describe("pmusAsks", () => {
  const book = {
    marketData: {
      state: "MARKET_STATE_OPEN",
      bids: [{ px: { value: "0.4300" }, qty: "25" }, { px: { value: "0.4200" }, qty: "86" }],
      offers: [{ px: { value: "0.4500" }, qty: "566" }, { px: { value: "0.4400" }, qty: "266.1" }],
    },
  };
  it("YES asks are offers; NO asks are 1 - bids; cheapest first", () => {
    expect(pmusAsks(book, "yes")).toEqual([{ price: 0.44, size: 266.1 }, { price: 0.45, size: 566 }]);
    expect(pmusAsks(book, "no")).toEqual([{ price: 0.57, size: 25 }, { price: 0.58, size: 86 }]);
  });
  it("returns nothing when the market is not open", () => {
    expect(pmusAsks({ marketData: { ...book.marketData, state: "MARKET_STATE_SUSPENDED" } }, "yes")).toEqual([]);
  });
});

describe("toMarketView with an equivalent core", () => {
  const l = (venue: Listing["venue"], spec: PayoutSpec, preview: Listing["preview"]): Listing => ({
    venue, marketId: venue, title: venue, url: "", spec, legs: { yes: "", no: "" }, closeTime: "2026-11-12T07:00:00.000Z", rulesText: "", preview,
  });
  const pm = l("polymarket", spec(extractPolymarketUpDown(sameWindowPoly, "BTC")), { yes: 0.4, no: 0.5 });
  const us = l("polymarket-us", spec(extractPolymarketUsUpDown(pmusBtc15m)), { yes: 0.44, no: 0.57 });
  const k = l("kalshi", spec(extractKalshiUpDown(sameWindowKalshi, "BTC")), { yes: 0.45, no: 0.56 });
  const pair = (a: Listing, b: Listing) => ({ a, b, ...compareSpecs(a.spec!, b.spec!) });

  it("quotes Kalshi + Polymarket US by default and keeps Polymarket intl as an opt-in extra", () => {
    const m = toMarketView({ key: "k", listings: [pm, us, k], pairs: [pair(pm, us), pair(pm, k), pair(us, k)], bestTier: "near-equivalent" })!;
    expect(m.tier).toBe("near-equivalent");
    expect(m.badgeTier).toBe("equivalent");
    expect(m.core.map((x) => x.venue)).toEqual(["polymarket-us", "kalshi"]);
    // Card prices come from the core only (Polymarket intl's 40¢ needs consent).
    expect(m.best.yes).toEqual({ price: 0.44, venue: "polymarket-us" });
  });
});

describe("Polymarket US request sharing", () => {
  it("shares one fetch per key within the TTL and does not cache failures", async () => {
    const { cached } = await import("@/lib/venues/polymarket-us");
    let calls = 0;
    const load = async () => ++calls;
    const [a, b] = await Promise.all([cached("t1", 1000, load, 0), cached("t1", 1000, load, 500)]);
    expect([a, b, calls]).toEqual([1, 1, 1]);
    expect(await cached("t1", 1000, load, 1500)).toBe(2);
    await expect(cached("t2", 1000, () => Promise.reject(new Error("429")), 0)).rejects.toThrow();
    expect(await cached("t2", 1000, async () => "ok", 1)).toBe("ok");
  });
});
