import { NextResponse } from "next/server";
import { recordDeposit } from "@/lib/orders/engine";
import { errorResponse } from "@/lib/orders/http";

export const dynamic = "force-dynamic";

/** POST /api/orders/:id/deposited { txHash } : the user's NEAR deposit transaction. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { txHash?: string };
  if (!body.txHash || !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(body.txHash))
    return NextResponse.json({ error: "txHash (base58) required" }, { status: 400 });
  try {
    return NextResponse.json({ order: await recordDeposit(id, body.txHash) });
  } catch (e) {
    return errorResponse(e);
  }
}
