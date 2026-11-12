import { NextResponse } from "next/server";
import { listLiveExecutions, liveEnabled, maxLiveUsd } from "@/lib/live/execute";
import { LIVE_VENUES } from "@/lib/live/orders";

export const dynamic = "force-dynamic";

/** GET /api/live : whether this server offers live orders, the cap, and recent executions. */
export async function GET() {
  const enabled = liveEnabled();
  return NextResponse.json({ enabled, maxUsd: maxLiveUsd(), liveVenues: LIVE_VENUES, recent: enabled ? listLiveExecutions(5) : [] });
}
