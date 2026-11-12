/**
 * Live split orders on regulated venues with each user's OWN API keys. Server-only.
 *
 * The server never sees a venue secret. It plans and records; the user's browser signs:
 *   1. plan    POST /api/live/plan    re-quote on the server, guards, build each leg's exact order body
 *   2. send    Polymarket US: the browser signs and posts the planned body straight to api.polymarket.us
 *              Kalshi (no browser CORS for auth headers): the browser signs, the server relays ONLY the
 *              planned body for that leg, once, while the plan is fresh (POST /api/live/:id/kalshi)
 *   3. report  POST /api/live/:id/report  the browser reports the Polymarket US response
 *
 * Guards: ONEBOOK_LIVE_ORDERS=on, budget <= MAX_LIVE_USD ($10), markets only on LIVE_VENUES, one plan per
 * requestId, plans expire after PLAN_TTL_MS, each leg is sent at most once.
 *
 * Every leg is a fill-or-kill limit order: all at the limit price or better, or nothing. Legs are NOT
 * atomic with each other; a partial route is reported, never retried or unwound automatically.
 */
import { randomUUID } from "node:crypto";
import {
  authHeaders,
  filledFrom,
  isLiveVenue,
  KALSHI_PATHS,
  KALSHI_TRADE,
  legShares,
  LIVE_VENUES,
  orderBody,
  orderIdFrom,
  type LiveVenue,
} from "@/lib/live/orders";
import { openDb } from "@/lib/orders/store";
import { computeQuote, QuoteError, type QuoteInput } from "@/lib/quote";
import type { RoutePlan } from "@/lib/router";
import type { Side } from "@/lib/venues/types";

export const PLAN_TTL_MS = 30_000;
export const liveEnabled = (env = process.env) => env.ONEBOOK_LIVE_ORDERS === "on";
export const maxLiveUsd = (env = process.env) => Number(env.MAX_LIVE_USD ?? 10);

export interface LiveLeg {
  venue: LiveVenue;
  marketId: string;
  side: Side;
  /** Contracts the venue will be asked for (whole on Kalshi, 0.01 on Polymarket US). */
  shares: number;
  limitPrice: number;
  plannedCost: number;
  clientOrderId: string;
  body: Record<string, unknown>;
  status: "planned" | "sent" | "filled" | "not-filled" | "error";
  filled?: number;
  orderId?: string;
  error?: string;
  response?: unknown;
}

export interface LiveExecution {
  id: string;
  createdAt: string;
  expiresAt: string;
  input: QuoteInput;
  plan: RoutePlan;
  legs: LiveLeg[];
  outcome: "pending" | "all-filled" | "partial" | "none-filled";
}

export interface LiveDeps {
  quote: (q: QuoteInput) => Promise<{ plan: RoutePlan }>;
  now: () => Date;
  enabled: boolean;
  maxUsd: number;
  fetch: typeof fetch;
}

export const defaultLiveDeps = (): LiveDeps => ({
  quote: computeQuote,
  now: () => new Date(),
  enabled: liveEnabled(),
  maxUsd: maxLiveUsd(),
  fetch: (...a) => fetch(...a),
});

// ---------------------------------------------------------------- store

function table() {
  const db = openDb();
  db.exec(`CREATE TABLE IF NOT EXISTS live_executions (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, data TEXT NOT NULL)`);
  return db;
}
function insert(e: LiveExecution): boolean {
  const r = table().prepare("INSERT OR IGNORE INTO live_executions (id, created_at, data) VALUES (?, ?, ?)").run(e.id, e.createdAt, JSON.stringify(e));
  return Number(r.changes) === 1;
}
function save(e: LiveExecution) {
  table().prepare("UPDATE live_executions SET data = ? WHERE id = ?").run(JSON.stringify(e), e.id);
}
export function getLiveExecution(id: string): LiveExecution | null {
  const row = table().prepare("SELECT data FROM live_executions WHERE id = ?").get(id) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as LiveExecution) : null;
}
export function listLiveExecutions(limit = 20): LiveExecution[] {
  return (table().prepare("SELECT data FROM live_executions ORDER BY created_at DESC LIMIT ?").all(limit) as { data: string }[]).map(
    (r) => JSON.parse(r.data) as LiveExecution,
  );
}

function withOutcome(e: LiveExecution): LiveExecution {
  const done = e.legs.every((l) => l.status === "filled" || l.status === "not-filled" || l.status === "error");
  const filled = e.legs.filter((l) => l.status === "filled").length;
  return { ...e, outcome: !done ? "pending" : filled === e.legs.length ? "all-filled" : filled === 0 ? "none-filled" : "partial" };
}

function settleLeg(l: LiveLeg, res: unknown): LiveLeg {
  const filled = filledFrom(l.venue, res);
  return { ...l, response: res, filled, orderId: orderIdFrom(l.venue, res), status: filled > 0 ? "filled" : "not-filled" };
}

// ---------------------------------------------------------------- 1. plan

export async function planLive(input: QuoteInput & { requestId: string }, deps: LiveDeps = defaultLiveDeps()): Promise<LiveExecution> {
  if (!deps.enabled) throw new QuoteError("live orders are off on this server (ONEBOOK_LIVE_ORDERS)", 403);
  if (!/^[\w-]{8,64}$/.test(input.requestId ?? "")) throw new QuoteError("requestId: 8-64 chars [A-Za-z0-9_-]", 400);
  if (input.budgetUsd > deps.maxUsd) throw new QuoteError(`live limit: at most $${deps.maxUsd} per order`, 400);
  const bad = input.markets.find((m) => !isLiveVenue(m.venue));
  if (bad) throw new QuoteError(`${bad.venue} is not a live venue (live: ${LIVE_VENUES.join(", ")})`, 400);

  const { plan } = await deps.quote(input);
  const legs: LiveLeg[] = [];
  for (const a of plan.allocations) {
    const venue = a.venue as LiveVenue;
    const order = { marketId: a.marketId, side: plan.side, shares: a.shares, limitPrice: a.limitPrice, clientOrderId: randomUUID() };
    const shares = legShares(venue, order);
    if (shares <= 0) continue; // e.g. under one whole Kalshi contract
    legs.push({
      venue,
      marketId: a.marketId,
      side: plan.side,
      shares,
      limitPrice: a.limitPrice,
      plannedCost: a.cost,
      clientOrderId: order.clientOrderId,
      body: orderBody(venue, order),
      status: "planned",
    });
  }
  if (legs.length === 0) throw new QuoteError("no venue can fill this order right now", 409);

  const now = deps.now();
  const e: LiveExecution = {
    id: input.requestId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PLAN_TTL_MS).toISOString(),
    input: { markets: input.markets, side: input.side, budgetUsd: input.budgetUsd, allowNearEquivalent: input.allowNearEquivalent },
    plan,
    legs,
    outcome: "pending",
  };
  if (!insert(e)) throw new QuoteError("this request id was already used", 409);
  return e;
}

// ---------------------------------------------------------------- 2. Kalshi relay

function claimLeg(id: string, leg: number, venue: LiveVenue, now: Date): { e: LiveExecution; l: LiveLeg } {
  const e = getLiveExecution(id);
  if (!e) throw new QuoteError("unknown plan", 404);
  const l = e.legs[leg];
  if (!l || l.venue !== venue) throw new QuoteError(`leg ${leg} is not a ${venue} leg`, 400);
  if (l.status !== "planned") throw new QuoteError("this leg was already sent", 409);
  if (now > new Date(e.expiresAt)) throw new QuoteError("plan expired: prices may have moved, review again", 410);
  e.legs[leg] = { ...l, status: "sent" };
  save(e);
  return { e, l };
}

/**
 * Forward the user's signed Kalshi request. The signature is computed in the browser over
 * `ts + POST + /trade-api/v2/portfolio/events/orders`; the body is the one this server planned.
 */
export async function relayKalshiOrder(
  a: { id: string; leg: number; keyId: string; ts: string; signature: string },
  deps: LiveDeps = defaultLiveDeps(),
): Promise<LiveExecution> {
  if (!deps.enabled) throw new QuoteError("live orders are off on this server (ONEBOOK_LIVE_ORDERS)", 403);
  const { e, l } = claimLeg(a.id, a.leg, "kalshi", deps.now());
  let next: LiveLeg;
  try {
    const res = await deps.fetch(`${KALSHI_TRADE}/portfolio/events/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders("kalshi", a.keyId, a.ts, a.signature) },
      body: JSON.stringify(l.body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep text */
    }
    next = res.ok ? settleLeg(l, body) : { ...l, status: "error", response: body, error: `Kalshi HTTP ${res.status}: ${text.slice(0, 200)}` };
  } catch (err) {
    next = { ...l, status: "error", error: (err as Error).message };
  }
  e.legs[a.leg] = next;
  const out = withOutcome(e);
  save(out);
  return out;
}

/** Forward a signed Kalshi balance read (to check a key works). Nothing else is ever relayed. */
export async function relayKalshiBalance(a: { keyId: string; ts: string; signature: string }, deps: LiveDeps = defaultLiveDeps()) {
  const res = await deps.fetch(`${KALSHI_TRADE}/portfolio/balance`, {
    headers: authHeaders("kalshi", a.keyId, a.ts, a.signature),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) throw new QuoteError(`Kalshi HTTP ${res.status}: ${text.slice(0, 200)}`, res.status === 401 ? 401 : 502);
  return JSON.parse(text) as unknown;
}
export const KALSHI_BALANCE_PATH = KALSHI_PATHS.balance;

// ---------------------------------------------------------------- 3. report (Polymarket US, sent by the browser)

/**
 * Claim a Polymarket US leg just before the browser sends it: enforces the plan's freshness and that
 * each leg is sent at most once (across tabs too).
 */
export function claimPmusLeg(a: { id: string; leg: number }, deps: Pick<LiveDeps, "now"> = { now: () => new Date() }): LiveLeg {
  return claimLeg(a.id, a.leg, "polymarket-us", deps.now()).l;
}

export function reportLeg(a: { id: string; leg: number; response?: unknown; error?: string }) {
  const e = getLiveExecution(a.id);
  if (!e) throw new QuoteError("unknown plan", 404);
  const l = e.legs[a.leg];
  if (!l || l.venue !== "polymarket-us") throw new QuoteError(`leg ${a.leg} is not a polymarket-us leg`, 400);
  if (l.status !== "sent") throw new QuoteError(l.status === "planned" ? "claim the leg before sending it" : "this leg was already reported", 409);
  e.legs[a.leg] = a.error ? { ...l, status: "error", error: String(a.error).slice(0, 300), response: a.response } : settleLeg(l, a.response);
  const out = withOutcome(e);
  save(out);
  return out;
}
