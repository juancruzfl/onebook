/**
 * Browser side of live orders: sign with the user's own stored keys and send. Browser-only.
 * See src/lib/live/execute.ts for the server half and the guards.
 */
import { signRequest, type VenueConnection } from "@/lib/live/browser-keys";
import { authHeaders, KALSHI_PATHS, PMUS_API, PMUS_PATHS, type LiveVenue } from "@/lib/live/orders";
import type { LiveExecution } from "@/lib/live/execute";

async function json(res: Response): Promise<unknown> {
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }
  if (!res.ok) {
    const msg = (body as { error?: string; message?: string })?.error ?? (body as { message?: string })?.message ?? text.slice(0, 200);
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }
  return body;
}

/** Read the account balance with the stored key, to prove the key works. Returns the venue's raw response. */
export async function checkConnection(c: VenueConnection): Promise<unknown> {
  const ts = String(Date.now());
  if (c.venue === "polymarket-us") {
    const signature = await signRequest(c.key, ts, "GET", PMUS_PATHS.balance);
    return json(await fetch(`${PMUS_API}${PMUS_PATHS.balance}`, { headers: authHeaders("polymarket-us", c.keyId, ts, signature) }));
  }
  const signature = await signRequest(c.key, ts, "GET", KALSHI_PATHS.balance);
  return json(
    await fetch("/api/live/kalshi-balance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyId: c.keyId, ts, signature }),
    }),
  );
}

/** Best-effort USD figure from a balance response, for display only. */
export function balanceUsd(venue: LiveVenue, r: unknown): number | null {
  if (!r || typeof r !== "object") return null;
  if (venue === "kalshi") {
    const k = r as { balance?: number; balance_dollars?: string };
    return k.balance_dollars !== undefined ? Number(k.balance_dollars) : typeof k.balance === "number" ? k.balance / 100 : null;
  }
  // TODO(verify) Polymarket US /v1/account/balances shape: look for a buying-power-like number.
  const flat = JSON.stringify(r);
  const m = /"(?:buyingPower|availableBalance|cashBalance|balance)"\s*:\s*\{?\s*"?(?:value"\s*:\s*")?(-?\d+(?:\.\d+)?)/.exec(flat);
  return m ? Number(m[1]) : null;
}

export async function planLiveOrder(input: {
  markets: { venue: string; marketId: string }[];
  side: "yes" | "no";
  budgetUsd: number;
  requestId: string;
}): Promise<LiveExecution> {
  return json(
    await fetch("/api/live/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }),
  ) as Promise<LiveExecution>;
}

/** Sign and send one planned leg. Resolves to the updated execution (as recorded by the server). */
export async function sendLeg(e: LiveExecution, leg: number, c: VenueConnection): Promise<LiveExecution> {
  const l = e.legs[leg];
  if (c.venue !== l.venue) throw new Error("wrong account for this leg");
  if (Date.now() > new Date(e.expiresAt).getTime()) throw new Error("plan expired: review again");
  const ts = String(Date.now());

  if (l.venue === "kalshi") {
    const signature = await signRequest(c.key, ts, "POST", KALSHI_PATHS.order);
    return json(
      await fetch(`/api/live/${e.id}/kalshi`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leg, keyId: c.keyId, ts, signature }),
      }),
    ) as Promise<LiveExecution>;
  }

  // Polymarket US: reserve the leg on the server, then send straight from the browser.
  await json(await fetch(`/api/live/${e.id}/claim`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ leg }) }));
  let report: { response?: unknown; error?: string };
  try {
    const signature = await signRequest(c.key, ts, "POST", PMUS_PATHS.order);
    const res = await fetch(`${PMUS_API}${PMUS_PATHS.order}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders("polymarket-us", c.keyId, ts, signature) },
      body: JSON.stringify(l.body),
    });
    report = { response: await json(res) };
  } catch (err) {
    report = { error: (err as Error).message };
  }
  return json(
    await fetch(`/api/live/${e.id}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leg, ...report }),
    }),
  ) as Promise<LiveExecution>;
}
