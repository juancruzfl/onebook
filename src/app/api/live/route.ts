import { NextResponse } from "next/server";
import { kalshiCredsFromEnv, pmusCredsFromEnv } from "@/lib/live/auth";
import { LIVE_VENUES, listLiveExecutions, liveEnabled, maxLiveUsd } from "@/lib/live/execute";
import { kalshiBalanceUsd, pmusBalanceUsd } from "@/lib/live/venues";

export const dynamic = "force-dynamic";

/**
 * GET /api/live : is live trading on, which venues have keys, and do the keys work (balance check).
 * Balances are only read when live trading is on.
 */
export async function GET() {
  const enabled = liveEnabled();
  const venues: Record<string, { connected: boolean; balance?: unknown; error?: string }> = {};
  const settle = async (venue: string, has: boolean, read: () => Promise<unknown>) => {
    if (!has) return (venues[venue] = { connected: false });
    if (!enabled) return (venues[venue] = { connected: true });
    try {
      venues[venue] = { connected: true, balance: await read() };
    } catch (e) {
      venues[venue] = { connected: false, error: (e as Error).message };
    }
  };
  try {
    const k = kalshiCredsFromEnv();
    const p = pmusCredsFromEnv();
    await Promise.all([
      settle("kalshi", !!k, () => kalshiBalanceUsd(k!)),
      settle("polymarket-us", !!p, () => pmusBalanceUsd(p!)),
    ]);
  } catch (e) {
    return NextResponse.json({ enabled, maxUsd: maxLiveUsd(), liveVenues: LIVE_VENUES, error: (e as Error).message }, { status: 500 });
  }
  return NextResponse.json({
    enabled,
    maxUsd: maxLiveUsd(),
    liveVenues: LIVE_VENUES,
    venues,
    recent: enabled ? listLiveExecutions(5) : [],
  });
}
