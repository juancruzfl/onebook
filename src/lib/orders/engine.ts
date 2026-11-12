/**
 * Execution queue: the two-leg flow (NEAR Intents swap → Polymarket order) as a persistent state machine.
 * See docs/ARCHITECTURE.md → Execution. Server-only.
 *
 * Safety properties:
 *  - The order is signed BEFORE any funds move; the user can stop after signing at no cost.
 *  - Funds only ever go to the user's own Chain Signatures address (swap) or back to their NEAR account (refund).
 *  - The venue order is never posted: ORDER_DRY_RUN is final (US geo restriction, see README → Compliance).
 */
import { randomUUID } from "node:crypto";
import { createPublicClient, erc20Abi, http, isAddressEqual, recoverTypedDataAddress, type Address } from "viem";
import { polygon } from "viem/chains";
import { ASSETS, getStatus, requestQuote, submitDeposit, tokenPriceUsd, USDC_POLYGON_ADDRESS, type QuoteResponse, type StatusResponse } from "@/lib/intents/oneclick";
import { deriveEvmAddress } from "@/lib/near/chainsig";
import { mpcResultToEvmSignature, mpcSignTx } from "@/lib/near/mpc";
import { wrapAndDepositTx } from "@/lib/near/wrap";
import { ACTIVE_STATES, type OrderRecord, type OrderState } from "@/lib/orders/types";
import { getOrder, listOrders, saveOrder } from "@/lib/orders/store";
import { buildBuyOrder, orderHash, orderTypedData } from "@/lib/polymarket/order";
import { computeQuote, QuoteError, type QuoteInput } from "@/lib/quote";
import type { RoutePlan } from "@/lib/router";
import type { Listing } from "@/lib/venues/types";

/** Hard cap per order while this is a demo. Override with MAX_ORDER_USD. */
export const MAX_ORDER_USD = Number(process.env.MAX_ORDER_USD ?? 10);
/** Polymarket minimum order size in shares. TODO(verify) per market (Gamma `orderMinSize`). */
const MIN_SHARES = 5;
/** Extra NEAR deposited on top of the USD target to cover 1Click fees and slippage. */
const NEAR_BUFFER = 1.03;
const QUOTE_TTL_MS = 20 * 60 * 1000;

/** External effects, injectable for tests. */
export interface EngineDeps {
  computeQuote: (q: QuoteInput) => Promise<{ plan: RoutePlan; listings: Listing[] }>;
  deriveEvmAddress: (account: string) => Promise<{ address: Address }>;
  nearPriceUsd: () => Promise<number>;
  requestQuote: typeof requestQuote;
  getStatus: (depositAddress: string) => Promise<StatusResponse>;
  submitDeposit: (depositAddress: string, txHash: string) => Promise<void>;
  usdcBalance: (address: Address) => Promise<bigint>;
  now: () => Date;
}

const polygonClient = () => createPublicClient({ chain: polygon, transport: http(process.env.POLYGON_RPC_URL) });

export const defaultDeps: EngineDeps = {
  computeQuote,
  deriveEvmAddress: (a) => deriveEvmAddress(a, "mainnet"),
  nearPriceUsd: () => tokenPriceUsd(ASSETS.wNEAR),
  requestQuote,
  getStatus,
  submitDeposit,
  usdcBalance: (address) =>
    polygonClient().readContract({ address: USDC_POLYGON_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
  now: () => new Date(),
};

function transition(o: OrderRecord, state: OrderState, note: string, now: Date): OrderRecord {
  const at = now.toISOString();
  return { ...o, state, updatedAt: at, events: [...o.events, { at, state, note }] };
}

/** Round shares down to 2 decimals so the order never spends more than the swap guarantees. */
const floor2 = (x: number) => Math.floor(x * 100 + 1e-9) / 100;

export interface PreparedOrder {
  order: OrderRecord;
  /** Send in this order: sign first (no funds move), then deposit. */
  nearTxs: { sign: ReturnType<typeof mpcSignTx>; deposit: ReturnType<typeof wrapAndDepositTx> };
}

/**
 * Build an executable order for the Polymarket leg of a route:
 * route → 1Click quote (NEAR → USDC on Polygon, to the user's derived address) → V2 order sized from
 * the quote's guaranteed minimum output → the two NEAR transactions the wallet must send.
 */
export async function prepareOrder(account: string, q: QuoteInput, deps: EngineDeps = defaultDeps): Promise<PreparedOrder> {
  if (q.budgetUsd > MAX_ORDER_USD) throw new QuoteError(`demo limit: at most $${MAX_ORDER_USD} per order`, 400);

  // Only Polymarket orders can be signed today (EVM / Chain Signatures), so execution routes the whole
  // amount there. The combined multi-venue quote stays available via /api/quote for comparison.
  const pm = q.markets.filter((m) => m.venue === "polymarket");
  if (pm.length !== 1) throw new QuoteError("this market has no Polymarket listing to execute on", 422);
  const { plan, listings } = await deps.computeQuote({ ...q, markets: pm });
  const alloc = plan.allocations.find((a) => a.venue === "polymarket");
  const listing = listings.find((l) => l.venue === "polymarket");
  if (!alloc || !listing) throw new QuoteError("Polymarket cannot fill this order right now", 422);

  const { address: evmAddress } = await deps.deriveEvmAddress(account);
  const price = await deps.nearPriceUsd();
  const now = deps.now();
  const amountNear = (alloc.cost / price) * NEAR_BUFFER;
  const amountYocto = (BigInt(Math.ceil(amountNear * 1e6)) * BigInt(10) ** BigInt(18)).toString(); // 6 dp of NEAR

  const quote: QuoteResponse = await deps.requestQuote({
    dry: false,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: ASSETS.wNEAR,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: ASSETS.USDC_POLYGON,
    amount: amountYocto,
    recipient: evmAddress,
    recipientType: "DESTINATION_CHAIN",
    refundTo: account,
    refundType: "ORIGIN_CHAIN",
    deadline: new Date(now.getTime() + QUOTE_TTL_MS).toISOString(),
  });
  const depositAddress = quote.quote.depositAddress;
  if (!depositAddress) throw new Error("1Click returned no deposit address");
  if (quote.quote.depositMemo) throw new Error("deposit memos are not supported");

  // Size the order from the swap's guaranteed minimum so it can always be funded.
  const minUsdc = Number(quote.quote.minAmountOut) / 1e6;
  const shares = floor2(minUsdc / alloc.limitPrice);
  if (shares < MIN_SHARES)
    throw new QuoteError(`Polymarket's minimum is ${MIN_SHARES} shares; increase the amount (would get ${shares})`, 422);

  const { order, exchange } = buildBuyOrder({
    maker: evmAddress,
    tokenId: listing.legs[q.side],
    price: alloc.limitPrice,
    shares,
    nowMs: now.getTime(),
  });
  const hash = orderHash(order, exchange);
  const outcome = q.side === "yes" ? "Up" : "Down";

  let rec: OrderRecord = {
    id: randomUUID(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    state: "AWAITING_SIGNATURE",
    account,
    evmAddress,
    market: { venue: "polymarket", marketId: listing.marketId, title: listing.title, side: q.side, outcome, tokenId: listing.legs[q.side] },
    limitPrice: alloc.limitPrice,
    shares,
    usdcAmount: order.makerAmount,
    expiresAt: new Date(
      Math.min(now.getTime() + QUOTE_TTL_MS, listing.closeTime ? Date.parse(listing.closeTime) - 60_000 : Infinity),
    ).toISOString(),
    order,
    exchange,
    orderHash: hash,
    swap: {
      depositAddress,
      amountIn: quote.quote.amountIn,
      amountInFormatted: quote.quote.amountInFormatted,
      amountOutFormatted: quote.quote.amountOutFormatted,
      minAmountOut: quote.quote.minAmountOut,
      deadline: quote.quote.deadline ?? quote.quoteRequest.deadline,
      correlationId: quote.correlationId,
    },
    events: [],
  };
  rec = transition(rec, "AWAITING_SIGNATURE", `Quote: ${quote.quote.amountInFormatted} NEAR → ≥ ${minUsdc.toFixed(2)} USDC on Polygon; order ${shares} ${outcome} @ ≤ ${alloc.limitPrice}`, now);
  saveOrder(rec);
  return { order: rec, nearTxs: { sign: mpcSignTx(hash, "mainnet"), deposit: wrapAndDepositTx(depositAddress, quote.quote.amountIn) } };
}

function load(id: string, expected: OrderState): OrderRecord {
  const o = getOrder(id);
  if (!o) throw new QuoteError("order not found", 404);
  if (o.state !== expected) throw new QuoteError(`order is ${o.state}, expected ${expected}`, 409);
  return o;
}

/** Step 1 done: verify the MPC signature recovers to the user's derived address before any money moves. */
export async function recordSignature(id: string, mpcResult: unknown, signTxHash: string | undefined, deps: EngineDeps = defaultDeps) {
  const o = load(id, "AWAITING_SIGNATURE");
  const signature = mpcResultToEvmSignature(mpcResult);
  const recovered = await recoverTypedDataAddress({ ...orderTypedData(o.order, o.exchange), signature });
  if (!isAddressEqual(recovered, o.evmAddress)) {
    const bad = transition({ ...o, error: `signature recovers to ${recovered}` }, "ERROR", "Signature did not match the derived address", deps.now());
    saveOrder(bad);
    throw new QuoteError("signature does not match the account's derived address", 422);
  }
  const next = transition({ ...o, signature, signTxHash }, "AWAITING_DEPOSIT_TX", "Order signed by NEAR account via Chain Signatures", deps.now());
  saveOrder(next);
  return next;
}

/** Step 2 done: user sent the NEAR deposit. */
export async function recordDeposit(id: string, txHash: string, deps: EngineDeps = defaultDeps) {
  const o = load(id, "AWAITING_DEPOSIT_TX");
  await deps.submitDeposit(o.swap.depositAddress, txHash);
  const next = transition({ ...o, swap: { ...o.swap, depositTxHash: txHash } }, "AWAITING_SWAP", `Deposit sent (${txHash.slice(0, 10)}…)`, deps.now());
  saveOrder(next);
  return next;
}

const inFlight = new Set<string>();

/** Move one order forward by at most one step. Safe to call often and concurrently. */
export async function advance(id: string, deps: EngineDeps = defaultDeps): Promise<OrderRecord | null> {
  const o = getOrder(id);
  if (!o || !ACTIVE_STATES.includes(o.state) || inFlight.has(id)) return o;
  inFlight.add(id);
  try {
    const now = deps.now();
    let next: OrderRecord | null = null;
    switch (o.state) {
      case "AWAITING_SIGNATURE":
      case "AWAITING_DEPOSIT_TX": {
        if (now > new Date(o.expiresAt)) {
          // If a deposit was sent but never reported, 1Click still tracks it: hand over to the swap step.
          const st = await deps.getStatus(o.swap.depositAddress).catch(() => null);
          next =
            st && st.status !== "PENDING_DEPOSIT"
              ? transition(o, "AWAITING_SWAP", `Deposit detected by 1Click (${st.status})`, now)
              : transition(o, "EXPIRED", "Quote expired before a deposit; no funds moved", now);
        }
        break;
      }
      case "AWAITING_SWAP": {
        const st = await deps.getStatus(o.swap.depositAddress);
        if (st.status !== o.swap.status) next = { ...o, swap: { ...o.swap, status: st.status } };
        if (st.status === "SUCCESS")
          next = transition(next ?? o, "SWAP_SETTLED", "USDC delivered to your Polygon address", now);
        else if (st.status === "REFUNDED" || st.status === "FAILED" || st.status === "INCOMPLETE_DEPOSIT")
          next = transition(next ?? o, "SWAP_FAILED", `Swap ${st.status.toLowerCase()}; 1Click returns funds to ${o.account}`, now);
        break;
      }
      case "SWAP_SETTLED": {
        const balance = await deps.usdcBalance(o.evmAddress);
        const funded = balance >= BigInt(o.usdcAmount);
        const payload = { order: { ...o.order, signature: o.signature }, orderType: "FOK", owner: "<clob-api-key>" };
        next = transition(
          { ...o, usdcBalance: balance.toString(), dryRunPayload: payload },
          "ORDER_DRY_RUN",
          funded
            ? `Order is funded (${(Number(balance) / 1e6).toFixed(2)} USDC) and signed. Not posted: dry run.`
            : `Balance ${(Number(balance) / 1e6).toFixed(2)} USDC is below the order's ${(Number(o.usdcAmount) / 1e6).toFixed(2)}. Not posted: dry run.`,
          now,
        );
        break;
      }
    }
    if (next) saveOrder(next);
    return next ?? o;
  } catch (e) {
    // Transient errors (RPC, 1Click) are retried on the next tick; only log them.
    console.warn(`[orders] advance ${id} failed:`, (e as Error).message);
    return o;
  } finally {
    inFlight.delete(id);
  }
}

/** Worker tick: advance every active order. */
export async function tickAll(deps: EngineDeps = defaultDeps): Promise<void> {
  for (const o of listOrders({ states: ACTIVE_STATES, limit: 100 })) await advance(o.id, deps);
}
