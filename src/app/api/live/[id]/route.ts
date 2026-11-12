import { NextResponse } from "next/server";
import { getLiveExecution } from "@/lib/live/execute";

export const dynamic = "force-dynamic";

/** GET /api/live/:id : a live execution with per-leg results. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const e = getLiveExecution((await ctx.params).id);
  return e ? NextResponse.json(e) : NextResponse.json({ error: "not found" }, { status: 404 });
}
