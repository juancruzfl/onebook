import type { OrderJson } from "@/lib/polymarket/order";
import type { Side } from "@/lib/venues/types";

/**
 * AWAITING_SIGNATURE   order built; user must sign it via the MPC network (no funds moved yet)
 * AWAITING_DEPOSIT_TX  order signed; user must send the NEAR deposit to the 1Click address
 * AWAITING_SWAP        deposit sent; 1Click is swapping NEAR -> USDC on Polygon
 * SWAP_SETTLED         USDC delivered to the user's Chain Signatures address
 * ORDER_DRY_RUN        final: order validated against the on-chain balance, NOT posted (geo restriction)
 * SWAP_FAILED          final: 1Click refunded / failed; funds go back to the user's NEAR account
 * EXPIRED              final: quote deadline passed before the deposit
 * ERROR                final: unexpected failure, see `error`
 */
export type OrderState =
  | "AWAITING_SIGNATURE"
  | "AWAITING_DEPOSIT_TX"
  | "AWAITING_SWAP"
  | "SWAP_SETTLED"
  | "ORDER_DRY_RUN"
  | "SWAP_FAILED"
  | "EXPIRED"
  | "ERROR";

export const ACTIVE_STATES: OrderState[] = ["AWAITING_SIGNATURE", "AWAITING_DEPOSIT_TX", "AWAITING_SWAP", "SWAP_SETTLED"];

export interface OrderEvent {
  at: string;
  state: OrderState;
  note: string;
}

export interface OrderRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  state: OrderState;
  account: string;
  evmAddress: `0x${string}`;
  market: { venue: "polymarket"; marketId: string; title: string; side: Side; outcome: string; tokenId: string };
  /** Polymarket leg: limit price ($/share) and shares, sized from the swap's guaranteed minimum output. */
  limitPrice: number;
  shares: number;
  usdcAmount: string; // 6-decimal units the order spends
  order: OrderJson;
  exchange: `0x${string}`;
  orderHash: `0x${string}`;
  signature?: `0x${string}`;
  /** When an unfunded order is abandoned: min(quote TTL, 1 minute before the market closes). */
  expiresAt: string;
  /**
   * "balance": paid from USDC already at the user's Polygon address (added ahead of time via Funds); the
   * trade is sign-and-done. "swap": NEAR → USDC through 1Click at trade time. Missing = "swap" (older rows).
   */
  funding?: "balance" | "swap";
  /** Present only for funding === "swap". */
  swap?: {
    depositAddress: string;
    amountIn: string; // yoctoNEAR
    amountInFormatted: string;
    amountOutFormatted: string;
    minAmountOut: string; // USDC units
    /** 1Click's deposit-address lifetime (days), NOT our order expiry. */
    deadline: string;
    correlationId: string;
    depositTxHash?: string;
    status?: string;
  };
  signTxHash?: string;
  usdcBalance?: string;
  dryRunPayload?: unknown;
  error?: string;
  events: OrderEvent[];
}
