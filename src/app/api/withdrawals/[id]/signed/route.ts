import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/orders/http";
import { recordTransferSignature } from "@/lib/withdraw/engine";

export const dynamic = "force-dynamic";

/** POST /api/withdrawals/:id/signed { mpcResult, txHash } : verify, broadcast on Polygon, hand to 1Click. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const b = (await req.json().catch(() => ({}))) as { mpcResult?: unknown; txHash?: string };
  if (!b.mpcResult) return NextResponse.json({ error: "mpcResult required" }, { status: 400 });
  try {
    return NextResponse.json({ withdrawal: await recordTransferSignature((await ctx.params).id, b.mpcResult, b.txHash) });
  } catch (e) {
    return errorResponse(e);
  }
}
