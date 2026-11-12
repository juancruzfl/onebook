import { NextResponse } from "next/server";
import { isAccountId } from "@/lib/near/chain-constants";
import { errorResponse } from "@/lib/orders/http";
import { startWithdrawal } from "@/lib/withdraw/engine";

export const dynamic = "force-dynamic";

/** POST /api/withdrawals { account } : start withdrawing all USDC at the account's Polygon address to NEAR. */
export async function POST(req: Request) {
  const { account } = (await req.json().catch(() => ({}))) as { account?: string };
  if (!account || !isAccountId(account)) return NextResponse.json({ error: "invalid NEAR account id" }, { status: 400 });
  try {
    return NextResponse.json(await startWithdrawal(account), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
