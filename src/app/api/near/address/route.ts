import { NextResponse } from "next/server";
import { deriveEvmAddress } from "@/lib/near/chainsig";

export const dynamic = "force-dynamic";

/** NEAR account id rules (same regex the hackathon API uses). */
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/**
 * GET /api/near/address?account=alice.near[&network=testnet]
 * The EVM address (same on Polygon, Base, …) that only `account` can sign for via Chain Signatures.
 * Read-only: no transaction, no cost.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const account = url.searchParams.get("account") ?? "";
  const network = url.searchParams.get("network") === "testnet" ? "testnet" : "mainnet";
  if (account.length < 2 || account.length > 64 || !ACCOUNT_RE.test(account))
    return NextResponse.json({ error: "invalid NEAR account id" }, { status: 400 });
  return NextResponse.json(await deriveEvmAddress(account, network));
}
