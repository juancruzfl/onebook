import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/orders/http";
import { prepareTransfer } from "@/lib/withdraw/engine";

export const dynamic = "force-dynamic";

/** POST /api/withdrawals/:id/prepare : quote USDC → NEAR, build the Polygon transfer, return the v1.signer tx. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    return NextResponse.json(await prepareTransfer((await ctx.params).id));
  } catch (e) {
    return errorResponse(e);
  }
}
