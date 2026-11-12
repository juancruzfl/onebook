/**
 * Pure, browser-safe pieces of live trading on regulated venues: endpoints, signing messages and order
 * bodies. Shared by the server (planning, relay) and the browser (signing with the user's own keys).
 *
 * Both venues sign `timestamp_ms + METHOD + path` (path from the API root, no query string). Neither
 * signature covers the body, which is why the server only relays bodies it built itself.
 *
 * Price convention on both venues: the price always refers to the YES side. Buying NO at q is
 * selling YES at 1 - q (Kalshi `side: "ask"`, Polymarket US `ORDER_INTENT_BUY_SHORT`).
 */
import type { Side } from "@/lib/venues/types";

export const KALSHI_TRADE = "https://api.elections.kalshi.com/trade-api/v2";
export const KALSHI_PATHS = {
  order: "/trade-api/v2/portfolio/events/orders",
  balance: "/trade-api/v2/portfolio/balance",
} as const;

export const PMUS_API = "https://api.polymarket.us";
export const PMUS_PATHS = { order: "/v1/orders", balance: "/v1/account/balances" } as const;

export type LiveVenue = "kalshi" | "polymarket-us";
export const LIVE_VENUES: LiveVenue[] = ["kalshi", "polymarket-us"];
export const isLiveVenue = (v: string): v is LiveVenue => (LIVE_VENUES as string[]).includes(v);

export const signingMessage = (ts: string, method: string, path: string) => `${ts}${method.toUpperCase()}${path.split("?")[0]}`;

/** YES-side price, 4 decimals as both venues expect. */
export function yesPrice(side: Side, limit: number): string {
  const p = side === "yes" ? limit : 1 - limit;
  return (Math.round(p * 1e4) / 1e4).toFixed(4);
}

export interface LegOrder {
  marketId: string;
  side: Side;
  shares: number;
  /** Worst acceptable price for the leg being bought (YES or NO), 0-1. */
  limitPrice: number;
  clientOrderId: string;
}

/** Kalshi orders are whole contracts; fill-or-kill at the limit. */
export function kalshiOrderBody(o: LegOrder) {
  return {
    ticker: o.marketId,
    client_order_id: o.clientOrderId,
    side: o.side === "yes" ? "bid" : "ask",
    count: Math.floor(o.shares).toFixed(2),
    price: yesPrice(o.side, o.limitPrice),
    time_in_force: "fill_or_kill",
    self_trade_prevention_type: "taker_at_cross",
  };
}

/** Polymarket US quantity in 0.01 contracts (minimumTradeQty on 15m crypto markets); fill-or-kill. */
export function pmusOrderBody(o: LegOrder) {
  return {
    marketSlug: o.marketId,
    type: "ORDER_TYPE_LIMIT",
    price: { value: yesPrice(o.side, o.limitPrice), currency: "USD" },
    quantity: Math.floor(o.shares * 100) / 100,
    tif: "TIME_IN_FORCE_FILL_OR_KILL",
    intent: o.side === "yes" ? "ORDER_INTENT_BUY_LONG" : "ORDER_INTENT_BUY_SHORT",
    manualOrderIndicator: "MANUAL_ORDER_INDICATOR_MANUAL",
    synchronousExecution: true,
    maxBlockTime: "5",
  };
}

export const orderBody = (venue: LiveVenue, o: LegOrder) => (venue === "kalshi" ? kalshiOrderBody(o) : pmusOrderBody(o));
export const legShares = (venue: LiveVenue, o: LegOrder) =>
  venue === "kalshi" ? Number(kalshiOrderBody(o).count) : pmusOrderBody(o).quantity;

/** Contracts filled, from each venue's create-order response. */
export function filledFrom(venue: LiveVenue, res: unknown): number {
  if (!res || typeof res !== "object") return 0;
  if (venue === "kalshi") return Number((res as { fill_count?: string }).fill_count ?? 0) || 0;
  const ex = (res as { executions?: { lastShares?: string | number }[] }).executions ?? [];
  return ex.reduce((s, e) => s + (Number(e.lastShares) || 0), 0);
}

export const orderIdFrom = (venue: LiveVenue, res: unknown): string | undefined =>
  !res || typeof res !== "object"
    ? undefined
    : venue === "kalshi"
      ? (res as { order_id?: string }).order_id
      : (res as { id?: string }).id;

/** Signed-request headers the venue expects. */
export function authHeaders(venue: LiveVenue, keyId: string, ts: string, signature: string): Record<string, string> {
  return venue === "kalshi"
    ? { "KALSHI-ACCESS-KEY": keyId, "KALSHI-ACCESS-TIMESTAMP": ts, "KALSHI-ACCESS-SIGNATURE": signature }
    : { "X-PM-Access-Key": keyId, "X-PM-Timestamp": ts, "X-PM-Signature": signature };
}
