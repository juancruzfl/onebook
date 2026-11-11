import { describe, expect, it } from "vitest";
import { extractPolymarketUpDown, polymarketLegs } from "@/lib/extractors/polymarket";
import { extractKalshiThreshold, extractKalshiUpDown } from "@/lib/extractors/kalshi";
import { extractHyperliquidPriceBinary, hlCoin, parseHlExpiry } from "@/lib/extractors/hyperliquid";
import { kalshiAsks } from "@/lib/venues/kalshi";
import { hlBtcDaily, kalshiBtc15m, kalshiBtcDaily, polyBtc15m, polyBtc15mLegacy } from "./fixtures";

describe("polymarket up/down", () => {
  it("extracts the 2026 TWAP template", () => {
    const r = extractPolymarketUpDown(polyBtc15m, "BTC");
    expect(r.ok && r.spec).toEqual({
      kind: "price-compare",
      cmp: ">=",
      end: { asset: "BTC", oracle: "chainlink-twap-60s", aggregation: { kind: "average", seconds: 60, anchor: "unspecified" }, at: "2026-11-11T23:15:00.000Z" },
      start: { asset: "BTC", oracle: "chainlink-twap-60s", aggregation: { kind: "average", seconds: 60, anchor: "unspecified" }, at: "2026-11-11T23:00:00.000Z" },
    });
  });
  it("extracts the legacy point template", () => {
    const r = extractPolymarketUpDown(polyBtc15mLegacy, "BTC");
    expect(r.ok && r.spec.kind === "price-compare" && r.spec.end.oracle).toBe("chainlink-data-stream");
  });
  it("refuses unknown rule text", () => {
    expect(extractPolymarketUpDown({ ...polyBtc15m, description: "Resolves at the discretion of the team." }, "BTC").ok).toBe(false);
  });
  it("maps Up to yes by label, not position", () => {
    expect(polymarketLegs({ ...polyBtc15m, outcomes: '["Down", "Up"]' })).toEqual({ yes: "3715357678", no: "4305889536" });
  });
});

describe("kalshi", () => {
  it("extracts 15m up/down with trailing 60s BRTI average", () => {
    const r = extractKalshiUpDown(kalshiBtc15m, "BTC");
    expect(r.ok && r.spec.kind === "price-compare" && r.spec.start).toEqual({
      asset: "BTC", oracle: "cf-benchmarks-rti", aggregation: { kind: "average", seconds: 60, anchor: "trailing" }, at: "2026-11-11T23:00:00.000Z",
    });
  });
  it("extracts daily threshold with strict comparator", () => {
    const r = extractKalshiThreshold(kalshiBtcDaily, "BTC");
    expect(r.ok && r.spec.kind === "price-threshold" && [r.spec.cmp, r.spec.strike]).toEqual([">", 83249.99]);
  });
  it("rejects range markets", () => {
    expect(extractKalshiThreshold({ ...kalshiBtcDaily, strike_type: "between" }, "BTC").ok).toBe(false);
  });
  it("derives YES asks from NO bids", () => {
    const asks = kalshiAsks({ orderbook_fp: { yes_dollars: [["0.30", "5"]], no_dollars: [["0.60", "10"], ["0.65", "4"]] } }, "yes");
    expect(asks).toEqual([{ price: 0.35, size: 4 }, { price: 0.4, size: 10 }]);
  });
});

describe("hyperliquid", () => {
  it("parses expiry as UTC", () => {
    expect(parseHlExpiry("20260504-0600")).toBe("2026-05-04T06:00:00.000Z");
  });
  it("extracts priceBinary as >= threshold on mark price", () => {
    const r = extractHyperliquidPriceBinary(hlBtcDaily);
    expect(r.ok && r.spec).toEqual({
      kind: "price-threshold", cmp: ">=", strike: 83249.99,
      ref: { asset: "BTC", oracle: "hyperliquid-mark", aggregation: { kind: "point" }, at: "2026-11-12T22:00:00.000Z" },
    });
  });
  it("encodes outcome coins", () => {
    expect([hlCoin(1, 0), hlCoin(1, 1)]).toEqual(["#10", "#11"]);
  });
});
