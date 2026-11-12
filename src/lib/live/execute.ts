/**
 * Live split execution across regulated venues, using the operator's own accounts. Server-only.
 *
 * Guards (all must pass, every time):
 * - ONEBOOK_LIVE_ORDERS=on (off by default)
 * - budget <= MAX_LIVE_USD (default $10), and an explicit `confirm: true` from a user click
 * - the route is re-quoted on the server (fungibility re-checked) and only uses LIVE_VENUES with keys
 * - a requestId can only be executed once
 *
 * Legs are independent fill-or-kill limit orders sent in parallel. Each leg fills completely at its
 * limit price or better, or not at all. Legs are NOT atomic with each other: one can fill while the
 * other is killed. The result says so per leg; nothing is retried or unwound automatically.
 */
import { kalshiCredsFromEnv, pmusCredsFromEnv } from "@/lib/live/auth";
import { kalshiPlacer, newClientOrderId, pmusPlacer, type LegResult, type Placer } from "@/lib/live/venues";
import { openDb } from "@/lib/orders/store";
import { computeQuote, QuoteError, type QuoteInput } from "@/lib/quote";
import type { RoutePlan } from "@/lib/router";
import type { Side, VenueId } from "@/lib/venues/types";

/** Venues onebook may send live orders to: CFTC-regulated, with the operator's own KYC'd account. */
export const LIVE_VENUES: VenueId[] = ["kalshi", "polymarket-us"];

export const liveEnabled = (env = process.env) => env.ONEBOOK_LIVE_ORDERS === "on";
export const maxLiveUsd = (env = process.env) => Number(env.MAX_LIVE_USD ?? 10);

export interface LiveLeg {
  venue: VenueId;
  marketId: string;
  side: Side;
  plannedShares: number;
  limitPrice: number;
  plannedCost: number;
  clientOrderId: string;
  status: "filled" | "not-filled" | "error";
  result?: LegResult;
  error?: string;
}

export interface LiveExecution {
  id: string;
  createdAt: string;
  input: QuoteInput;
  plan: RoutePlan;
  legs: LiveLeg[];
  outcome: "all-filled" | "partial" | "none-filled";
}

export interface LiveDeps {
  quote: (q: QuoteInput) => Promise<{ plan: RoutePlan }>;
  placers: Partial<Record<VenueId, Placer>>;
  now: () => Date;
  enabled: boolean;
  maxUsd: number;
}

export function defaultLiveDeps(): LiveDeps {
  const placers: LiveDeps["placers"] = {};
  const k = kalshiCredsFromEnv();
  const p = pmusCredsFromEnv();
  if (k) placers.kalshi = kalshiPlacer(k);
  if (p) placers["polymarket-us"] = pmusPlacer(p);
  return { quote: computeQuote, placers, now: () => new Date(), enabled: liveEnabled(), maxUsd: maxLiveUsd() };
}

// ---------------------------------------------------------------- store

function table() {
  const db = openDb();
  db.exec(`CREATE TABLE IF NOT EXISTS live_executions (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, data TEXT NOT NULL)`);
  return db;
}
function claim(id: string, createdAt: string): boolean {
  const r = table().prepare("INSERT OR IGNORE INTO live_executions (id, created_at, data) VALUES (?, ?, '{}')").run(id, createdAt);
  return Number(r.changes) === 1;
}
function save(e: LiveExecution) {
  table().prepare("UPDATE live_executions SET data = ? WHERE id = ?").run(JSON.stringify(e), e.id);
}
export function listLiveExecutions(limit = 20): LiveExecution[] {
  return (table().prepare("SELECT data FROM live_executions WHERE data != '{}' ORDER BY created_at DESC LIMIT ?").all(limit) as {
    data: string;
  }[]).map((r) => JSON.parse(r.data) as LiveExecution);
}

// ---------------------------------------------------------------- engine

export async function executeLive(
  input: QuoteInput & { requestId: string; confirm: boolean },
  deps: LiveDeps = defaultLiveDeps(),
): Promise<LiveExecution> {
  if (!deps.enabled) throw new QuoteError("live orders are off (set ONEBOOK_LIVE_ORDERS=on)", 403);
  if (input.confirm !== true) throw new QuoteError("live orders need explicit confirmation", 400);
  if (!/^[\w-]{8,64}$/.test(input.requestId ?? "")) throw new QuoteError("requestId: 8-64 chars [A-Za-z0-9_-]", 400);
  if (input.budgetUsd > deps.maxUsd) throw new QuoteError(`live limit: at most $${deps.maxUsd} per order`, 400);
  const bad = input.markets.find((m) => !LIVE_VENUES.includes(m.venue));
  if (bad) throw new QuoteError(`${bad.venue} is not a live venue (live: ${LIVE_VENUES.join(", ")})`, 400);

  const { plan } = await deps.quote(input);
  const allocs = plan.allocations.filter((a) => a.shares > 0);
  if (allocs.length === 0) throw new QuoteError("no venue can fill this order right now", 409);
  const missing = allocs.find((a) => !deps.placers[a.venue]);
  if (missing) throw new QuoteError(`no API key configured for ${missing.venue}`, 400);

  const createdAt = deps.now().toISOString();
  if (!claim(input.requestId, createdAt)) throw new QuoteError("this request was already executed", 409);

  const legs: LiveLeg[] = allocs.map((a) => ({
    venue: a.venue,
    marketId: a.marketId,
    side: plan.side,
    plannedShares: a.shares,
    limitPrice: a.limitPrice,
    plannedCost: a.cost,
    clientOrderId: newClientOrderId(),
    status: "not-filled",
  }));
  const results = await Promise.allSettled(
    legs.map((l) =>
      deps.placers[l.venue]!({ marketId: l.marketId, side: l.side, shares: l.plannedShares, limitPrice: l.limitPrice, clientOrderId: l.clientOrderId }),
    ),
  );
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      legs[i].result = r.value;
      legs[i].status = r.value.filled > 0 ? "filled" : "not-filled";
    } else {
      legs[i].status = "error";
      legs[i].error = String((r.reason as Error)?.message ?? r.reason);
    }
  });
  const filled = legs.filter((l) => l.status === "filled").length;
  const e: LiveExecution = {
    id: input.requestId,
    createdAt,
    input: { markets: input.markets, side: input.side, budgetUsd: input.budgetUsd, allowNearEquivalent: input.allowNearEquivalent },
    plan,
    legs,
    outcome: filled === legs.length ? "all-filled" : filled === 0 ? "none-filled" : "partial",
  };
  save(e);
  return e;
}
