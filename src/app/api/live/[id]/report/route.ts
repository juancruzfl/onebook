import { NextResponse } from "next/server";
import { reportLeg } from "@/lib/live/execute";
import { errorResponse } from "@/lib/orders/http";

export const dynamic = "force-dynamic";

/** POST /api/live/:id/report { leg, response?, error? } : the browser reports the Polymarket US response. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const b = (await req.json().catch(() => ({}))) as { leg?: number; response?: unknown; error?: string };
  if (typeof b.leg !== "number") return NextResponse.json({ error: "leg required" }, { status: 400 });
  try {
    return NextResponse.json(reportLeg({ id, leg: b.leg, response: b.response, error: b.error }));
  } catch (e) {
    return errorResponse(e);
  }
}
