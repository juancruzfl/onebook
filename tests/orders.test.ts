import { beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount, sign } from "viem/accounts";
process.env.ONEBOOK_DB = ":memory:";
import { advance, prepareOrder, recordDeposit, recordSignature, type EngineDeps } from "@/lib/orders/engine";
import { _resetStore, getOrder } from "@/lib/orders/store";
import type { QuoteResponse, SwapStatus } from "@/lib/intents/oneclick";
import type { RoutePlan } from "@/lib/router";
import type { Listing } from "@/lib/venues/types";

// Throwaway key (Hardhat #0) standing in for the MPC-derived key.
const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const user = privateKeyToAccount(PK);

const listing = {
  venue: "polymarket", marketId: "0xabc", title: "Bitcoin Up or Down", url: "", spec: null,
  legs: { yes: "111", no: "222" }, closeTime: "2026-11-12T04:15:00.000Z", rulesText: "",
} as unknown as Listing;

const plan = (cost: number, limit: number): RoutePlan => ({
  side: "yes", budgetUsd: cost, totalShares: cost / limit, totalCost: cost, avgPrice: limit, bestSingleVenue: null, improvementUsd: 0,
  allocations: [{ venue: "polymarket", marketId: "0xabc", shares: cost / limit, cost, fees: 0, avgPrice: limit, limitPrice: limit }],
});

/**
 * `startBalance`: USDC already at the Polygon address when the order is prepared (0 = pay via swap).
 * `balance`: what the address holds afterwards (after the swap delivered).
 */
function deps(
  over: Partial<EngineDeps> & { status?: SwapStatus; balance?: bigint; startBalance?: bigint; minOut?: string; clock?: { t: number } } = {},
): EngineDeps {
  const clock = over.clock ?? { t: Date.parse("2026-11-12T04:00:00Z") };
  let reads = 0;
  return {
    computeQuote: async () => ({ plan: plan(5, 0.5), listings: [listing] }),
    deriveEvmAddress: async () => ({ address: user.address }),
    nearPriceUsd: async () => 3.5,
    requestQuote: async (req) =>
      ({
        quote: {
          depositAddress: "a".repeat(64), amountIn: req.amount, amountInFormatted: "1.47", amountInUsd: "5.1", minAmountIn: req.amount,
          amountOut: "5050000", amountOutFormatted: "5.05", amountOutUsd: "5.05", minAmountOut: over.minOut ?? "5000000",
          deadline: req.deadline, timeEstimate: 26,
        },
        quoteRequest: req, signature: "ed25519:x", timestamp: "", correlationId: "c-1",
      }) as QuoteResponse,
    getStatus: async () => ({ status: over.status ?? "SUCCESS" }),
    submitDeposit: async () => undefined,
    usdcBalance: async () => (reads++ === 0 ? (over.startBalance ?? BigInt(0)) : (over.balance ?? BigInt(5_050_000))),
    now: () => new Date(clock.t),
    ...over,
  };
}

const input = { markets: [{ venue: "polymarket" as const, marketId: "0xabc" }], side: "yes" as const, budgetUsd: 5 };

async function mpcSign(hash: `0x${string}`) {
  const s = await sign({ hash, privateKey: PK });
  return { big_r: { affine_point: `${s.yParity ? "03" : "02"}${s.r.slice(2)}` }, s: { scalar: s.s.slice(2) }, recovery_id: s.yParity };
}

beforeEach(() => _resetStore());

describe("order engine", () => {
  it("runs sign → deposit → swap → funded dry run", async () => {
    const d = deps();
    const { order, nearTxs } = await prepareOrder("alice.near", input, d);
    expect(order.state).toBe("AWAITING_SIGNATURE");
    expect(order.shares).toBe(10); // min 5.00 USDC / 0.5
    expect(order.usdcAmount).toBe("5000000");
    expect(nearTxs.sign.receiverId).toBe("v1.signer");
    expect(order.funding).toBe("swap");
    expect(nearTxs.deposit!.receiverId).toBe("wrap.near");
    expect(nearTxs.deposit!.actions.map((a) => a.params.methodName)).toEqual(["storage_deposit", "near_deposit", "ft_transfer"]);

    await recordSignature(order.id, await mpcSign(order.orderHash), "signTx", d);
    expect(getOrder(order.id)!.state).toBe("AWAITING_DEPOSIT_TX");
    await recordDeposit(order.id, "depTx", d);
    expect(getOrder(order.id)!.state).toBe("AWAITING_SWAP");
    await advance(order.id, d);
    expect(getOrder(order.id)!.state).toBe("SWAP_SETTLED");
    await advance(order.id, d);
    const done = getOrder(order.id)!;
    expect(done.state).toBe("ORDER_DRY_RUN");
    expect(done.events.at(-1)!.note).toMatch(/funded/);
    expect(done.events.map((e) => e.state)).toEqual(["AWAITING_SIGNATURE", "AWAITING_DEPOSIT_TX", "AWAITING_SWAP", "SWAP_SETTLED", "ORDER_DRY_RUN"]);
  });

  it("rejects a signature from the wrong key and never asks for the deposit", async () => {
    const d = deps();
    const { order } = await prepareOrder("alice.near", input, d);
    const other = await sign({ hash: order.orderHash, privateKey: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" });
    const bad = { big_r: { affine_point: `${other.yParity ? "03" : "02"}${other.r.slice(2)}` }, s: { scalar: other.s.slice(2) }, recovery_id: other.yParity };
    await expect(recordSignature(order.id, bad, undefined, d)).rejects.toThrow(/does not match/);
    expect(getOrder(order.id)!.state).toBe("ERROR");
    await expect(recordDeposit(order.id, "x", d)).rejects.toThrow(/expected AWAITING_DEPOSIT_TX/);
  });

  it("marks refunded swaps as failed", async () => {
    const d = deps({ status: "REFUNDED" });
    const { order } = await prepareOrder("alice.near", input, d);
    await recordSignature(order.id, await mpcSign(order.orderHash), undefined, d);
    await recordDeposit(order.id, "depTx", d);
    await advance(order.id, d);
    expect(getOrder(order.id)!.state).toBe("SWAP_FAILED");
  });

  it("expires unfunded orders after the quote deadline", async () => {
    const clock = { t: Date.parse("2026-11-12T04:00:00Z") };
    const d = deps({ clock, status: "PENDING_DEPOSIT" });
    const { order } = await prepareOrder("alice.near", input, d);
    clock.t += 21 * 60 * 1000;
    await advance(order.id, d);
    expect(getOrder(order.id)!.state).toBe("EXPIRED");
  });

  it("enforces the per-order cap and Polymarket's minimum size", async () => {
    await expect(prepareOrder("alice.near", { ...input, budgetUsd: 500 }, deps())).rejects.toThrow(/demo limit/);
    await expect(prepareOrder("alice.near", input, deps({ minOut: "2000000" }))).rejects.toThrow(/minimum is 5 shares/);
  });

  it("reports an unfunded order honestly", async () => {
    const d = deps({ balance: BigInt(1_000_000) });
    const { order } = await prepareOrder("alice.near", input, d);
    await recordSignature(order.id, await mpcSign(order.orderHash), undefined, d);
    await recordDeposit(order.id, "depTx", d);
    await advance(order.id, d);
    await advance(order.id, d);
    expect(getOrder(order.id)!.events.at(-1)!.note).toMatch(/below the order/);
  });
});

describe("order expiry", () => {
  it("expires one minute before the market closes, even inside the quote TTL", async () => {
    const clock = { t: Date.parse("2026-11-12T04:10:00Z") }; // market closes 04:15
    const d = deps({ clock, status: "PENDING_DEPOSIT" });
    const { order } = await prepareOrder("alice.near", input, d);
    expect(order.expiresAt).toBe("2026-11-12T04:14:00.000Z");
    clock.t = Date.parse("2026-11-12T04:14:30Z");
    await advance(order.id, d);
    expect(getOrder(order.id)!.state).toBe("EXPIRED");
  });
});

describe("paid from the trading balance", () => {
  it("skips the swap: one signature and the order is done", async () => {
    const d = deps({ startBalance: BigInt(5_120_000), balance: BigInt(5_120_000) });
    const { order, nearTxs } = await prepareOrder("alice.near", input, d);
    expect(order.funding).toBe("balance");
    expect(order.swap).toBeUndefined();
    expect(nearTxs.deposit).toBeUndefined();
    expect(order.shares).toBe(10); // $5 / 0.5
    const done = await recordSignature(order.id, await mpcSign(order.orderHash), "signTx", d);
    expect(done.state).toBe("ORDER_DRY_RUN");
    expect(done.events.map((e) => e.state)).toEqual(["AWAITING_SIGNATURE", "SWAP_SETTLED", "ORDER_DRY_RUN"]);
    expect(done.events.at(-1)!.note).toMatch(/funded/);
    await expect(recordDeposit(order.id, "x", d)).rejects.toThrow();
  });

  it("falls back to a swap when the balance is short, and expires unsigned balance orders quickly", async () => {
    const short = await prepareOrder("alice.near", input, deps({ startBalance: BigInt(4_000_000) }));
    expect(short.order.funding).toBe("swap");

    const clock = { t: Date.parse("2026-11-12T04:00:00Z") };
    const d = deps({ clock, startBalance: BigInt(9_000_000) });
    const { order } = await prepareOrder("alice.near", input, d);
    expect(order.expiresAt).toBe("2026-11-12T04:02:00.000Z");
    clock.t += 3 * 60 * 1000;
    await advance(order.id, d);
    expect(getOrder(order.id)!.state).toBe("EXPIRED");
  });
});
