import { NextResponse } from "next/server";
import { startFunding } from "@/lib/funding/engine";
import { isTargetId } from "@/lib/funding/targets";
import { isAccountId } from "@/lib/near/chain-constants";
import { errorResponse } from "@/lib/orders/http";

export const dynamic = "force-dynamic";

/**
 * POST /api/funding { account, target: "polygon", usd }
 * Quote NEAR → collateral (+ gas if low) to the account's address on that chain; returns ONE wallet tx.
 */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { account?: string; target?: string; usd?: number };
  if (!b.account || !isAccountId(b.account)) return NextResponse.json({ error: "invalid NEAR account id" }, { status: 400 });
  const target = b.target ?? "polygon";
  if (!isTargetId(target)) return NextResponse.json({ error: `unknown target ${target}` }, { status: 400 });
  try {
    return NextResponse.json(await startFunding(b.account, target, Number(b.usd)), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
