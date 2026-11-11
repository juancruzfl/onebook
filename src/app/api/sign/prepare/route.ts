import { NextResponse } from "next/server";
import { isAccountId } from "@/lib/near/chain-constants";
import { deriveEvmAddress } from "@/lib/near/chainsig";
import { mpcSignTx } from "@/lib/near/mpc";
import { buildBuyOrder, orderHash } from "@/lib/polymarket/order";

export const dynamic = "force-dynamic";

/**
 * POST /api/sign/prepare { account, tokenId?, price?, shares? }
 * Builds a Polymarket V2 BUY order whose maker is the account's Chain Signatures address, and the NEAR
 * transaction the user's wallet must send so the MPC network signs it. Nothing is signed here.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { account?: string; tokenId?: string; price?: number; shares?: number };
  const account = body.account ?? "";
  if (!isAccountId(account)) return NextResponse.json({ error: "invalid NEAR account id" }, { status: 400 });
  const tokenId = body.tokenId ?? "1"; // sample token id unless a real one is given
  if (!/^\d{1,78}$/.test(tokenId)) return NextResponse.json({ error: "tokenId must be a uint256" }, { status: 400 });

  const { address } = await deriveEvmAddress(account, "mainnet");
  const { order, exchange } = buildBuyOrder({ maker: address, tokenId, price: body.price ?? 0.5, shares: body.shares ?? 1 });
  const hash = orderHash(order, exchange);
  return NextResponse.json({ account, evmAddress: address, order, exchange, hash, nearTx: mpcSignTx(hash, "mainnet") });
}
