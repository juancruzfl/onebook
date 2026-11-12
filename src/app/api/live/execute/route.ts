import { NextResponse } from "next/server";
import { executeLive } from "@/lib/live/execute";
import { errorResponse } from "@/lib/orders/http";
import { validateQuoteInput, type QuoteInput } from "@/lib/quote";

export const dynamic = "force-dynamic";

/**
 * Live orders trade the operator's own accounts, so only accept requests addressed to this machine.
 * Host headers can be forged by anyone who can reach the port: also bind the server to 127.0.0.1.
 */
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * POST /api/live/execute { markets, side, budgetUsd, allowNearEquivalent, requestId, confirm: true }
 * Re-quotes on the server and sends one fill-or-kill limit order per venue leg. See src/lib/live/execute.ts.
 */
export async function POST(req: Request) {
  if (!LOCAL_HOST.test(req.headers.get("host") ?? ""))
    return NextResponse.json({ error: "live orders are only accepted on localhost" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as Partial<QuoteInput> & { requestId?: string; confirm?: boolean };
  try {
    const q = validateQuoteInput(body);
    return NextResponse.json(await executeLive({ ...q, requestId: body.requestId ?? "", confirm: body.confirm === true }), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
