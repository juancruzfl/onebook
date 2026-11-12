/**
 * NEAR Intents 1Click Swap API client (docs.near-intents.org → 1Click API).
 * Server-only: an optional ONECLICK_JWT removes the extra unauthenticated fee.
 */
import { getJson } from "@/lib/http";

export const ONECLICK = "https://1click.chaindefuser.com/v0";

/** Asset ids from GET /v0/tokens (verified 2026-11-12). */
export const ASSETS = {
  wNEAR: "nep141:wrap.near",
  /** Native USDC on Polygon (0x3c499c54…3359), 6 decimals. */
  USDC_POLYGON: "nep141:pol-0x3c499c542cef5e3811e1192ce70d8cc03d5c3359.omdep.near",
} as const;

export const USDC_POLYGON_ADDRESS = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359" as const;

export interface QuoteRequest {
  dry: boolean;
  swapType: "EXACT_INPUT" | "EXACT_OUTPUT";
  slippageTolerance: number; // bps
  originAsset: string;
  depositType: "ORIGIN_CHAIN";
  destinationAsset: string;
  amount: string;
  recipient: string;
  recipientType: "DESTINATION_CHAIN";
  refundTo: string;
  refundType: "ORIGIN_CHAIN";
  deadline: string;
}

export interface QuoteResponse {
  quote: {
    depositAddress?: string;
    depositMemo?: string;
    amountIn: string;
    amountInFormatted: string;
    amountInUsd: string;
    minAmountIn: string;
    amountOut: string;
    amountOutFormatted: string;
    amountOutUsd: string;
    minAmountOut: string;
    deadline?: string;
    timeEstimate: number;
    withdrawFee?: string;
  };
  quoteRequest: QuoteRequest;
  signature: string;
  timestamp: string;
  correlationId: string;
}

export type SwapStatus =
  | "PENDING_DEPOSIT"
  | "KNOWN_DEPOSIT_TX"
  | "PROCESSING"
  | "SUCCESS"
  | "INCOMPLETE_DEPOSIT"
  | "REFUNDED"
  | "FAILED";

export interface StatusResponse {
  status: SwapStatus;
  updatedAt?: string;
  swapDetails?: Record<string, unknown>;
}

const auth = (): Record<string, string> =>
  process.env.ONECLICK_JWT ? { Authorization: `Bearer ${process.env.ONECLICK_JWT}` } : {};

export async function requestQuote(req: QuoteRequest): Promise<QuoteResponse> {
  const res = await fetch(`${ONECLICK}/quote`, {
    method: "POST",
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
    headers: { "Content-Type": "application/json", ...auth() },
    body: JSON.stringify(req),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`1Click quote failed (${res.status}): ${JSON.stringify(json).slice(0, 300)}`);
  return json as QuoteResponse;
}

export const getStatus = (depositAddress: string) =>
  getJson<StatusResponse>(`${ONECLICK}/status?depositAddress=${encodeURIComponent(depositAddress)}`, { headers: auth() });

/** Optional: tells 1Click about the deposit so it is picked up faster. */
export async function submitDeposit(depositAddress: string, txHash: string): Promise<void> {
  await fetch(`${ONECLICK}/deposit/submit`, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: { "Content-Type": "application/json", ...auth() },
    body: JSON.stringify({ depositAddress, txHash }),
  }).catch(() => undefined);
}

export async function tokenPriceUsd(assetId: string): Promise<number> {
  const tokens = await getJson<{ assetId: string; price: number }[]>(`${ONECLICK}/tokens`);
  const t = tokens.find((x) => x.assetId === assetId);
  if (!t?.price) throw new Error(`no price for ${assetId}`);
  return t.price;
}
