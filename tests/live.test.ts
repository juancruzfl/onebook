import { generateKeyPairSync, verify, constants, createPublicKey } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ed25519FromSeed, pmusCredsFromEnv, signKalshi, signPolymarketUs, signingMessage } from "@/lib/live/auth";
import { executeLive, listLiveExecutions, type LiveDeps } from "@/lib/live/execute";
import { kalshiOrderBody, pmusOrderBody, yesPrice, type Placer } from "@/lib/live/venues";
import { _resetStore } from "@/lib/orders/store";
import type { RoutePlan } from "@/lib/router";

describe("request signing", () => {
  it("signs timestamp + METHOD + path without the query string", () => {
    expect(signingMessage("1703123456789", "get", "/trade-api/v2/portfolio/orders?limit=5")).toBe(
      "1703123456789GET/trade-api/v2/portfolio/orders",
    );
  });

  it("Kalshi RSA keys sign with RSA-PSS SHA-256", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const sig = signKalshi(privateKey, "1", "POST", "/trade-api/v2/portfolio/events/orders");
    const ok = verify(
      "sha256",
      Buffer.from("1POST/trade-api/v2/portfolio/events/orders"),
      { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST },
      Buffer.from(sig, "base64"),
    );
    expect(ok).toBe(true);
  });

  it("Polymarket US secrets (64-byte base64) sign with Ed25519 from the first 32 bytes", () => {
    const seed = Buffer.alloc(32, 7);
    const secret = Buffer.concat([seed, Buffer.alloc(32, 9)]).toString("base64");
    const creds = pmusCredsFromEnv({ PMUS_KEY_ID: "kid", PMUS_SECRET_KEY: secret })!;
    const sig = signPolymarketUs(creds.key, "5", "POST", "/v1/orders");
    const pub = createPublicKey(ed25519FromSeed(seed));
    expect(verify(null, Buffer.from("5POST/v1/orders"), pub, Buffer.from(sig, "base64"))).toBe(true);
  });

  it("no keys configured means no credentials", () => {
    expect(pmusCredsFromEnv({})).toBeNull();
  });
});

describe("order bodies", () => {
  const leg = { marketId: "M", shares: 7.89, limitPrice: 0.44, clientOrderId: "c1" };
  it("both venues price on the YES side", () => {
    expect(yesPrice("yes", 0.44)).toBe("0.4400");
    expect(yesPrice("no", 0.57)).toBe("0.4300");
  });
  it("Kalshi: whole contracts, bid for YES / ask for NO, fill-or-kill", () => {
    expect(kalshiOrderBody({ ...leg, side: "yes" })).toMatchObject({ ticker: "M", side: "bid", count: "7.00", price: "0.4400", time_in_force: "fill_or_kill" });
    expect(kalshiOrderBody({ ...leg, side: "no", limitPrice: 0.57 })).toMatchObject({ side: "ask", price: "0.4300" });
  });
  it("Polymarket US: 0.01 contracts, BUY_LONG for YES / BUY_SHORT for NO, fill-or-kill", () => {
    expect(pmusOrderBody({ ...leg, side: "yes" })).toMatchObject({
      marketSlug: "M",
      quantity: 7.89,
      price: { value: "0.4400", currency: "USD" },
      intent: "ORDER_INTENT_BUY_LONG",
      tif: "TIME_IN_FORCE_FILL_OR_KILL",
    });
    expect(pmusOrderBody({ ...leg, side: "no", limitPrice: 0.57 })).toMatchObject({ intent: "ORDER_INTENT_BUY_SHORT", price: { value: "0.4300" } });
  });
});

describe("executeLive", () => {
  const plan: RoutePlan = {
    side: "yes",
    budgetUsd: 10,
    allocations: [
      { venue: "kalshi", marketId: "KX", shares: 11, cost: 5, fees: 0.1, avgPrice: 0.45, limitPrice: 0.46 },
      { venue: "polymarket-us", marketId: "pm-us", shares: 11.2, cost: 5, fees: 0.1, avgPrice: 0.44, limitPrice: 0.45 },
    ],
    totalShares: 22.2,
    totalCost: 10,
    avgPrice: 0.45,
    bestSingleVenue: null,
    improvementUsd: 0.2,
  } as unknown as RoutePlan;
  const input = {
    markets: [{ venue: "kalshi" as const, marketId: "KX" }, { venue: "polymarket-us" as const, marketId: "pm-us" }],
    side: "yes" as const,
    budgetUsd: 10,
    requestId: "req-00000001",
    confirm: true,
  };
  const fill: Placer = async (o) => ({ orderId: `o-${o.marketId}`, filled: Math.floor(o.shares), sentShares: o.shares, sentPrice: "x" });
  const kill: Placer = async (o) => ({ orderId: `o-${o.marketId}`, filled: 0, sentShares: o.shares, sentPrice: "x" });
  const deps = (over: Partial<LiveDeps> = {}): LiveDeps => ({
    quote: async () => ({ plan }),
    placers: { kalshi: fill, "polymarket-us": fill },
    now: () => new Date("2026-11-12T07:00:00Z"),
    enabled: true,
    maxUsd: 10,
    ...over,
  });

  beforeEach(() => {
    process.env.ONEBOOK_DB = ":memory:";
    _resetStore();
  });
  afterEach(() => _resetStore());

  it("sends one order per leg and records the execution", async () => {
    const e = await executeLive(input, deps());
    expect(e.outcome).toBe("all-filled");
    expect(e.legs.map((l) => [l.venue, l.status])).toEqual([["kalshi", "filled"], ["polymarket-us", "filled"]]);
    expect(listLiveExecutions()).toHaveLength(1);
  });

  it("reports a partial fill without retrying or unwinding", async () => {
    const placeK = vi.fn(fill);
    const e = await executeLive(input, deps({ placers: { kalshi: placeK, "polymarket-us": kill } }));
    expect(e.outcome).toBe("partial");
    expect(placeK).toHaveBeenCalledTimes(1);
  });

  it("records venue errors per leg", async () => {
    const boom: Placer = async () => {
      throw new Error("HTTP 401");
    };
    const e = await executeLive(input, deps({ placers: { kalshi: boom, "polymarket-us": kill } }));
    expect(e.outcome).toBe("none-filled");
    expect(e.legs[0]).toMatchObject({ status: "error", error: "HTTP 401" });
  });

  it("refuses when off, unconfirmed, over the cap, on a non-live venue, without keys, or twice", async () => {
    const place = vi.fn(fill);
    await expect(executeLive(input, deps({ enabled: false }))).rejects.toThrow(/off/);
    await expect(executeLive({ ...input, confirm: false }, deps())).rejects.toThrow(/confirmation/);
    await expect(executeLive({ ...input, budgetUsd: 11 }, deps())).rejects.toThrow(/at most \$10/);
    await expect(
      executeLive({ ...input, markets: [...input.markets, { venue: "polymarket", marketId: "0x" }] }, deps()),
    ).rejects.toThrow(/not a live venue/);
    await expect(executeLive(input, deps({ placers: { kalshi: place } }))).rejects.toThrow(/no API key/);
    expect(place).not.toHaveBeenCalled();
    await executeLive(input, deps());
    await expect(executeLive(input, deps())).rejects.toThrow(/already executed/);
  });
});
