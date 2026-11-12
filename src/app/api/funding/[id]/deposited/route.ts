import { NextResponse } from "next/server";
import { recordFundingDeposit } from "@/lib/funding/engine";
import { errorResponse } from "@/lib/orders/http";

export const dynamic = "force-dynamic";

/** POST /api/funding/:id/deposited { txHash } : the wallet sent the NEAR deposit. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { txHash } = (await req.json().catch(() => ({}))) as { txHash?: string };
  if (!txHash || !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(txHash)) return NextResponse.json({ error: "txHash (base58) required" }, { status: 400 });
  try {
    return NextResponse.json({ funding: await recordFundingDeposit((await ctx.params).id, txHash) });
  } catch (e) {
    return errorResponse(e);
  }
}
