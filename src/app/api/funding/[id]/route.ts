import { NextResponse } from "next/server";
import { advanceFunding } from "@/lib/funding/engine";

export const dynamic = "force-dynamic";

/** GET /api/funding/:id : current state (also advances it one step). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const f = await advanceFunding((await ctx.params).id);
  return f ? NextResponse.json({ funding: f }) : NextResponse.json({ error: "not found" }, { status: 404 });
}
