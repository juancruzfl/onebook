import { NextResponse } from "next/server";
import { claimPmusLeg } from "@/lib/live/execute";
import { errorResponse } from "@/lib/orders/http";

export const dynamic = "force-dynamic";

/** POST /api/live/:id/claim { leg } : reserve a Polymarket US leg right before the browser sends it. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const b = (await req.json().catch(() => ({}))) as { leg?: number };
  if (typeof b.leg !== "number") return NextResponse.json({ error: "leg required" }, { status: 400 });
  try {
    return NextResponse.json(claimPmusLeg({ id, leg: b.leg }));
  } catch (e) {
    return errorResponse(e);
  }
}
