import { NextResponse } from "next/server";
import { relayKalshiOrder } from "@/lib/live/execute";
import { errorResponse } from "@/lib/orders/http";

export const dynamic = "force-dynamic";

/**
 * POST /api/live/:id/kalshi { leg, keyId, ts, signature }
 * Relays the PLANNED Kalshi order for that leg with the signature the user's browser made. No secret is sent.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const b = (await req.json().catch(() => ({}))) as { leg?: number; keyId?: string; ts?: string; signature?: string };
  if (typeof b.leg !== "number" || !b.keyId || !/^\d{13}$/.test(b.ts ?? "") || !b.signature)
    return NextResponse.json({ error: "leg, keyId, ts (ms), signature required" }, { status: 400 });
  try {
    return NextResponse.json(await relayKalshiOrder({ id, leg: b.leg, keyId: b.keyId, ts: b.ts!, signature: b.signature }));
  } catch (e) {
    return errorResponse(e);
  }
}
