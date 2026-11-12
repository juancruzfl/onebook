import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/orders/http";
import { recordGasDeposit } from "@/lib/withdraw/engine";

export const dynamic = "force-dynamic";

/** POST /api/withdrawals/:id/gas { txHash } : the NEAR gas deposit was sent. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { txHash } = (await req.json().catch(() => ({}))) as { txHash?: string };
  if (!txHash || !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(txHash)) return NextResponse.json({ error: "txHash (base58) required" }, { status: 400 });
  try {
    return NextResponse.json({ withdrawal: await recordGasDeposit((await ctx.params).id, txHash) });
  } catch (e) {
    return errorResponse(e);
  }
}
