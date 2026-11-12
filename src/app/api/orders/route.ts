import { NextResponse } from "next/server";
import { isAccountId } from "@/lib/near/chain-constants";
import { prepareOrder } from "@/lib/orders/engine";
import { errorResponse } from "@/lib/orders/http";
import { listOrders } from "@/lib/orders/store";
import { validateQuoteInput, type QuoteInput } from "@/lib/quote";

export const dynamic = "force-dynamic";

/**
 * POST /api/orders { account, markets, side, budgetUsd, allowNearEquivalent }
 * Prepares the Polymarket leg of a route for execution and returns the two NEAR transactions to send:
 * `sign` (MPC signs the order; no funds move) and then `deposit` (NEAR → 1Click deposit address).
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Partial<QuoteInput> & { account?: string };
  if (!body.account || !isAccountId(body.account)) return NextResponse.json({ error: "invalid NEAR account id" }, { status: 400 });
  try {
    return NextResponse.json(await prepareOrder(body.account, validateQuoteInput(body)), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

/** GET /api/orders?account=alice.near : recent orders for an account. */
export async function GET(req: Request) {
  const account = new URL(req.url).searchParams.get("account") ?? "";
  if (!isAccountId(account)) return NextResponse.json({ error: "invalid NEAR account id" }, { status: 400 });
  return NextResponse.json({ orders: listOrders({ account, limit: 20 }) });
}
