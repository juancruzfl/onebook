import { NextResponse } from "next/server";
import { relayKalshiBalance } from "@/lib/live/execute";
import { errorResponse } from "@/lib/orders/http";

export const dynamic = "force-dynamic";

/** POST /api/live/kalshi-balance { keyId, ts, signature } : check a browser-held Kalshi key works. */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { keyId?: string; ts?: string; signature?: string };
  if (!b.keyId || !/^\d{13}$/.test(b.ts ?? "") || !b.signature)
    return NextResponse.json({ error: "keyId, ts (ms), signature required" }, { status: 400 });
  try {
    return NextResponse.json(await relayKalshiBalance({ keyId: b.keyId, ts: b.ts!, signature: b.signature }));
  } catch (e) {
    return errorResponse(e);
  }
}
