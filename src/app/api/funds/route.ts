import { NextResponse } from "next/server";
import { MAX_FUND_USD } from "@/lib/funding/engine";
import { isAccountId } from "@/lib/near/chain-constants";
import { errorResponse } from "@/lib/orders/http";
import { funds } from "@/lib/withdraw/engine";

export const dynamic = "force-dynamic";

/** GET /api/funds?account=alice.near : USDC and POL at the account's Polygon address (Chain Signatures). */
export async function GET(req: Request) {
  const account = new URL(req.url).searchParams.get("account") ?? "";
  if (!isAccountId(account)) return NextResponse.json({ error: "invalid NEAR account id" }, { status: 400 });
  try {
    return NextResponse.json({ ...(await funds(account)), maxFundUsd: MAX_FUND_USD });
  } catch (e) {
    return errorResponse(e);
  }
}
