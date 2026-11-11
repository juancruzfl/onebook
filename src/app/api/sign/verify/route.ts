import { NextResponse } from "next/server";
import { isAddressEqual, recoverTypedDataAddress, type Address } from "viem";
import { isAccountId } from "@/lib/near/chain-constants";
import { deriveEvmAddress } from "@/lib/near/chainsig";
import { mpcResultToEvmSignature } from "@/lib/near/mpc";
import { orderTypedData, type OrderJson } from "@/lib/polymarket/order";

export const dynamic = "force-dynamic";

/**
 * POST /api/sign/verify { account, order, exchange, mpcResult }
 * Turns the MPC contract's return value into an EVM signature and checks that it recovers to the
 * account's Chain Signatures address. Proves the NEAR account can sign Polymarket orders.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { account?: string; order?: OrderJson; exchange?: Address; mpcResult?: unknown };
  if (!body.account || !isAccountId(body.account) || !body.order || !body.exchange || !body.mpcResult)
    return NextResponse.json({ error: "account, order, exchange and mpcResult are required" }, { status: 400 });
  try {
    const signature = mpcResultToEvmSignature(body.mpcResult);
    const recovered = await recoverTypedDataAddress({ ...orderTypedData(body.order, body.exchange), signature });
    const { address } = await deriveEvmAddress(body.account, "mainnet");
    return NextResponse.json({ signature, recovered, expected: address, valid: isAddressEqual(recovered, address) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 422 });
  }
}
