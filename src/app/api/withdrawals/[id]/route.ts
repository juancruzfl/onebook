import { NextResponse } from "next/server";
import { advanceWithdrawal } from "@/lib/withdraw/engine";

export const dynamic = "force-dynamic";

/** GET /api/withdrawals/:id : current state (also advances it one step). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const w = await advanceWithdrawal((await ctx.params).id);
  return w ? NextResponse.json({ withdrawal: w }) : NextResponse.json({ error: "not found" }, { status: 404 });
}
