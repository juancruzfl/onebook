import { NextResponse } from "next/server";
import { recordSignature } from "@/lib/orders/engine";
import { errorResponse } from "@/lib/orders/http";

export const dynamic = "force-dynamic";

/** POST /api/orders/:id/signed { mpcResult, txHash } : verifies the MPC signature before any deposit. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { mpcResult?: unknown; txHash?: string };
  if (!body.mpcResult) return NextResponse.json({ error: "mpcResult required" }, { status: 400 });
  try {
    return NextResponse.json({ order: await recordSignature(id, body.mpcResult, body.txHash) });
  } catch (e) {
    return errorResponse(e);
  }
}
