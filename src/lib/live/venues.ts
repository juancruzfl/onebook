/**
 * Live order clients for regulated venues, trading the operator's OWN accounts with the operator's OWN
 * API keys. Server-only. Every order is a fill-or-kill limit order at the route's limit price, so it
 * either fills completely at that price or better, or does nothing.
 *
 * Price convention on both venues: the price always refers to the YES side. Buying NO at q is
 * selling YES at 1 - q (Kalshi `side: "ask"`, Polymarket US `ORDER_INTENT_BUY_SHORT`).
 */
import { randomUUID } from "node:crypto";
import { r4 } from "@/lib/http";
import { signKalshi, signPolymarketUs, type KalshiCreds, type PmusCreds } from "@/lib/live/auth";
import type { Side } from "@/lib/venues/types";

export interface LegOrder {
  marketId: string;
  side: Side;
  shares: number;
  /** Worst acceptable price for the leg being bought (YES or NO), 0-1. */
  limitPrice: number;
  clientOrderId: string;
}

export interface LegResult {
  orderId?: string;
  /** Contracts actually filled. FOK: either all of `shares` or 0. */
  filled: number;
  sentShares: number;
  sentPrice: string;
  raw?: unknown;
}

export type Placer = (o: LegOrder) => Promise<LegResult>;

/** YES-side price for the order, 4 decimals as both venues expect. */
export const yesPrice = (side: Side, limit: number) => (side === "yes" ? r4(limit) : r4(1 - limit)).toFixed(4);

async function call(url: string, init: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }
  if (!res.ok) throw new Error(`${init.method} ${new URL(url).pathname} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  return body;
}

// ---------------------------------------------------------------- Kalshi

export const KALSHI_TRADE = "https://api.elections.kalshi.com/trade-api/v2";

export function kalshiRequest(creds: KalshiCreds, method: string, path: string, body?: unknown) {
  const ts = String(Date.now());
  const full = `/trade-api/v2${path}`;
  return call(`${KALSHI_TRADE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "KALSHI-ACCESS-KEY": creds.keyId,
      "KALSHI-ACCESS-TIMESTAMP": ts,
      "KALSHI-ACCESS-SIGNATURE": signKalshi(creds.key, ts, method, full),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Kalshi orders are whole contracts. */
export function kalshiOrderBody(o: LegOrder) {
  const count = Math.floor(o.shares);
  return {
    ticker: o.marketId,
    client_order_id: o.clientOrderId,
    side: o.side === "yes" ? "bid" : "ask",
    count: count.toFixed(2),
    price: yesPrice(o.side, o.limitPrice),
    time_in_force: "fill_or_kill",
    self_trade_prevention_type: "taker_at_cross",
  };
}

export const kalshiPlacer =
  (creds: KalshiCreds): Placer =>
  async (o) => {
    const body = kalshiOrderBody(o);
    if (Number(body.count) < 1) throw new Error("Kalshi leg is under 1 contract");
    const res = (await kalshiRequest(creds, "POST", "/portfolio/events/orders", body)) as {
      order_id?: string;
      fill_count?: string;
    };
    return { orderId: res.order_id, filled: Number(res.fill_count ?? 0), sentShares: Number(body.count), sentPrice: body.price, raw: res };
  };

export async function kalshiBalanceUsd(creds: KalshiCreds): Promise<number> {
  const r = (await kalshiRequest(creds, "GET", "/portfolio/balance")) as { balance?: number; balance_dollars?: string };
  // `balance` is in cents.
  return r.balance_dollars !== undefined ? Number(r.balance_dollars) : Number(r.balance ?? 0) / 100;
}

// ---------------------------------------------------------------- Polymarket US

export const PMUS_API = "https://api.polymarket.us";

export function pmusRequest(creds: PmusCreds, method: string, path: string, body?: unknown) {
  const ts = String(Date.now());
  return call(`${PMUS_API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-PM-Access-Key": creds.keyId,
      "X-PM-Timestamp": ts,
      "X-PM-Signature": signPolymarketUs(creds.key, ts, method, path),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Quantity in 0.01 contracts (minimumTradeQty on the 15m crypto markets). */
export function pmusOrderBody(o: LegOrder) {
  const quantity = Math.floor(o.shares * 100) / 100;
  return {
    marketSlug: o.marketId,
    type: "ORDER_TYPE_LIMIT",
    price: { value: yesPrice(o.side, o.limitPrice), currency: "USD" },
    quantity,
    tif: "TIME_IN_FORCE_FILL_OR_KILL",
    intent: o.side === "yes" ? "ORDER_INTENT_BUY_LONG" : "ORDER_INTENT_BUY_SHORT",
    manualOrderIndicator: "MANUAL_ORDER_INDICATOR_MANUAL",
    synchronousExecution: true,
    maxBlockTime: "5",
  };
}

export const pmusPlacer =
  (creds: PmusCreds): Placer =>
  async (o) => {
    const body = pmusOrderBody(o);
    if (body.quantity <= 0) throw new Error("Polymarket US leg is empty");
    const res = (await pmusRequest(creds, "POST", "/v1/orders", body)) as {
      id?: string;
      executions?: { lastShares?: string | number; orderRejectReason?: string }[];
    };
    const filled = (res.executions ?? []).reduce((s, e) => s + (Number(e.lastShares) || 0), 0);
    return { orderId: res.id, filled, sentShares: body.quantity, sentPrice: body.price.value, raw: res };
  };

export async function pmusBalanceUsd(creds: PmusCreds): Promise<unknown> {
  // TODO(verify) response shape; returned raw to the status endpoint.
  return pmusRequest(creds, "GET", "/v1/account/balances");
}

export const newClientOrderId = () => randomUUID();
