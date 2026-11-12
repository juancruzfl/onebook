import { NextResponse } from "next/server";
import { planLive } from "@/lib/live/execute";
import { errorResponse } from "@/lib/orders/http";
import { validateQuoteInput, type QuoteInput } from "@/lib/quote";

export const dynamic = "force-dynamic";

/** POST /api/live/plan { markets, side, budgetUsd, requestId } → legs with the exact order bodies to sign. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Partial<QuoteInput> & { requestId?: string };
  try {
    return NextResponse.json(await planLive({ ...validateQuoteInput(body), requestId: body.requestId ?? "" }), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
