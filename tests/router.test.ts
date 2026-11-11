import { describe, expect, it } from "vitest";
import { planRoute, type BookInput } from "@/lib/router";
import type { Level, Listing } from "@/lib/venues/types";

const book = (venue: Listing["venue"], asks: Level[], minOrder?: Listing["minOrder"], fee = 0): BookInput => ({
  listing: { venue, marketId: venue, title: venue, url: "", spec: null, legs: { yes: "", no: "" }, closeTime: "", rulesText: "", minOrder },
  asks,
  takerFee: (shares, price) => fee * shares * price * (1 - price),
});

describe("planRoute", () => {
  it("splits across venues cheapest first and beats the best single venue", () => {
    const plan = planRoute(
      [book("polymarket", [{ price: 0.4, size: 50 }, { price: 0.6, size: 1000 }]), book("kalshi", [{ price: 0.45, size: 50 }, { price: 0.7, size: 1000 }])],
      "yes",
      50,
    );
    // 50 @ 0.40 = $20, 50 @ 0.45 = $22.5, remaining $7.5 @ 0.60 = 12.5 shares
    expect(plan.totalShares).toBeCloseTo(112.5, 6);
    expect(plan.totalCost).toBeCloseTo(50, 6);
    expect(plan.bestSingleVenue?.venue).toBe("polymarket");
    expect(plan.bestSingleVenue?.shares).toBeCloseTo(50 + 30 / 0.6, 6);
    expect(plan.improvementUsd).toBeCloseTo(112.5 - 100, 6);
    expect(plan.allocations.find((a) => a.venue === "polymarket")?.limitPrice).toBe(0.6);
  });

  it("drops venues whose share is under their minimum order and refills elsewhere", () => {
    const plan = planRoute(
      [book("polymarket", [{ price: 0.5, size: 1000 }]), book("hyperliquid", [{ price: 0.49, size: 4 }], { notionalUsd: 10 })],
      "yes",
      20,
    );
    expect(plan.allocations.map((a) => a.venue)).toEqual(["polymarket"]);
    expect(plan.totalShares).toBeCloseTo(40, 6);
  });

  it("includes taker fees in the effective price", () => {
    const plan = planRoute([book("kalshi", [{ price: 0.5, size: 1000 }], undefined, 0.07)], "yes", 10);
    const unit = 0.5 + 0.07 * 0.25;
    expect(plan.totalShares).toBeCloseTo(10 / unit, 6);
    expect(plan.allocations[0].fees).toBeCloseTo((10 / unit) * 0.07 * 0.25, 6);
  });
});
