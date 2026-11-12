import { constants, createPublicKey, createPrivateKey, generateKeyPairSync, verify, webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importVenueKey, kalshiPemToPkcs8, pmusSecretToPkcs8, signRequest } from "@/lib/live/browser-keys";
import { claimPmusLeg, getLiveExecution, planLive, relayKalshiOrder, reportLeg, type LiveDeps } from "@/lib/live/execute";
import { filledFrom, kalshiOrderBody, pmusOrderBody, signingMessage, yesPrice } from "@/lib/live/orders";
import { _resetStore } from "@/lib/orders/store";
import type { RoutePlan } from "@/lib/router";

const subtle = webcrypto.subtle as unknown as SubtleCrypto;

describe("orders (pure)", () => {
  const leg = { marketId: "M", shares: 7.89, limitPrice: 0.44, clientOrderId: "c1" };
  it("signs timestamp + METHOD + path without the query string", () => {
    expect(signingMessage("1703123456789", "get", "/trade-api/v2/portfolio/orders?limit=5")).toBe("1703123456789GET/trade-api/v2/portfolio/orders");
  });
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
  it("reads fills from each venue's response", () => {
    expect(filledFrom("kalshi", { fill_count: "7.00" })).toBe(7);
    expect(filledFrom("polymarket-us", { executions: [{ lastShares: "3.5" }, { lastShares: 4 }] })).toBe(7.5);
    expect(filledFrom("polymarket-us", { id: "x" })).toBe(0);
  });
});

describe("browser keys (WebCrypto)", () => {
  it("Polymarket US: 64-byte base64 secret → non-extractable Ed25519 key that verifies", async () => {
    const seed = Buffer.alloc(32, 7);
    const secret = Buffer.concat([seed, Buffer.alloc(32, 9)]).toString("base64");
    const key = await importVenueKey("polymarket-us", secret, subtle);
    expect(key.extractable).toBe(false);
    const sig = await signRequest(key, "5", "POST", "/v1/orders", subtle);
    const pub = createPublicKey(createPrivateKey({ key: Buffer.from(pmusSecretToPkcs8(secret)), format: "der", type: "pkcs8" }));
    expect(verify(null, Buffer.from("5POST/v1/orders"), pub, Buffer.from(sig, "base64"))).toBe(true);
  });

  it("Kalshi: PKCS#1 and PKCS#8 RSA PEMs import and sign with RSA-PSS SHA-256", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    for (const pem of [privateKey.export({ type: "pkcs1", format: "pem" }), privateKey.export({ type: "pkcs8", format: "pem" })]) {
      const key = await importVenueKey("kalshi", String(pem), subtle);
      const sig = await signRequest(key, "1", "POST", "/trade-api/v2/portfolio/events/orders", subtle);
      const ok = verify(
        "sha256",
        Buffer.from("1POST/trade-api/v2/portfolio/events/orders"),
        { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST },
        Buffer.from(sig, "base64"),
      );
      expect(ok).toBe(true);
    }
  });

  it("rejects malformed secrets with a readable error", () => {
    expect(() => pmusSecretToPkcs8("abcd")).toThrow(/Polymarket US secret/);
    expect(() => kalshiPemToPkcs8("not a pem")).toThrow(/BEGIN\/END/);
  });
});

describe("live execution (server)", () => {
  const plan = {
    side: "yes",
    budgetUsd: 10,
    allocations: [
      { venue: "kalshi", marketId: "KX", shares: 11.4, cost: 5, fees: 0.1, avgPrice: 0.45, limitPrice: 0.46 },
      { venue: "polymarket-us", marketId: "pm-us", shares: 11.234, cost: 5, fees: 0.1, avgPrice: 0.44, limitPrice: 0.45 },
    ],
    totalShares: 22.6,
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
  };
  let now = new Date("2026-11-12T07:00:00Z");
  const kalshiFetch = vi.fn<(...a: Parameters<typeof fetch>) => Promise<Response>>(async () => new Response(JSON.stringify({ order_id: "k1", fill_count: "11.00" }), { status: 201 }));
  const deps = (over: Partial<LiveDeps> = {}): LiveDeps => ({
    quote: async () => ({ plan }),
    now: () => now,
    enabled: true,
    maxUsd: 10,
    fetch: kalshiFetch as unknown as typeof fetch,
    ...over,
  });
  const signed = { keyId: "kid", ts: "1762930800000", signature: "c2ln" };

  beforeEach(() => {
    process.env.ONEBOOK_DB = ":memory:";
    _resetStore();
    now = new Date("2026-11-12T07:00:00Z");
    kalshiFetch.mockClear();
  });
  afterEach(() => _resetStore());

  it("plans exact venue bodies: whole Kalshi contracts, 0.01 Polymarket US contracts", async () => {
    const e = await planLive(input, deps());
    expect(e.legs.map((l) => [l.venue, l.shares, l.status])).toEqual([
      ["kalshi", 11, "planned"],
      ["polymarket-us", 11.23, "planned"],
    ]);
    expect(e.legs[0].body).toMatchObject({ ticker: "KX", count: "11.00", price: "0.4600" });
  });

  it("relays only the planned Kalshi body with the browser's signature, once", async () => {
    await planLive(input, deps());
    const e = await relayKalshiOrder({ id: input.requestId, leg: 0, ...signed }, deps());
    expect(e.legs[0]).toMatchObject({ status: "filled", filled: 11, orderId: "k1" });
    const [url, init] = kalshiFetch.mock.calls[0];
    expect(url).toBe("https://api.elections.kalshi.com/trade-api/v2/portfolio/events/orders");
    expect((init as RequestInit).headers).toMatchObject({ "KALSHI-ACCESS-KEY": "kid", "KALSHI-ACCESS-TIMESTAMP": signed.ts, "KALSHI-ACCESS-SIGNATURE": "c2ln" });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual(e.legs[0].body);
    await expect(relayKalshiOrder({ id: input.requestId, leg: 0, ...signed }, deps())).rejects.toThrow(/already sent/);
    await expect(relayKalshiOrder({ id: input.requestId, leg: 1, ...signed }, deps())).rejects.toThrow(/not a kalshi leg/);
  });

  it("Polymarket US legs are claimed, then reported; outcome combines both legs", async () => {
    await planLive(input, deps());
    await relayKalshiOrder({ id: input.requestId, leg: 0, ...signed }, deps());
    expect(() => reportLeg({ id: input.requestId, leg: 1, response: {} })).toThrow(/claim/);
    claimPmusLeg({ id: input.requestId, leg: 1 }, { now: () => now });
    expect(() => claimPmusLeg({ id: input.requestId, leg: 1 }, { now: () => now })).toThrow(/already sent/);
    const e = reportLeg({ id: input.requestId, leg: 1, response: { id: "p1", executions: [] } });
    expect(e.legs[1]).toMatchObject({ status: "not-filled", orderId: "p1" });
    expect(e.outcome).toBe("partial");
    expect(getLiveExecution(input.requestId)!.outcome).toBe("partial");
  });

  it("records venue errors and refuses stale plans", async () => {
    await planLive(input, deps());
    const e = await relayKalshiOrder(
      { id: input.requestId, leg: 0, ...signed },
      deps({ fetch: (async () => new Response("bad signature", { status: 401 })) as unknown as typeof fetch }),
    );
    expect(e.legs[0]).toMatchObject({ status: "error" });
    expect(e.legs[0].error).toMatch(/401/);
    now = new Date(now.getTime() + 31_000);
    expect(() => claimPmusLeg({ id: input.requestId, leg: 1 }, { now: () => now })).toThrow(/expired/);
  });

  it("refuses when off, over the cap, on a non-live venue, or with a reused request id", async () => {
    await expect(planLive(input, deps({ enabled: false }))).rejects.toThrow(/off/);
    await expect(planLive({ ...input, budgetUsd: 11 }, deps())).rejects.toThrow(/at most \$10/);
    await expect(planLive({ ...input, markets: [...input.markets, { venue: "polymarket", marketId: "0x" }] }, deps())).rejects.toThrow(
      /not a live venue/,
    );
    await planLive(input, deps());
    await expect(planLive(input, deps())).rejects.toThrow(/already used/);
    expect(kalshiFetch).not.toHaveBeenCalled();
  });
});
