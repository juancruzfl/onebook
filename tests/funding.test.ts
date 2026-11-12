import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuoteResponse, SwapStatus } from "@/lib/intents/oneclick";
import { advanceFunding, recordFundingDeposit, startFunding, type FundingDeps } from "@/lib/funding/engine";
import { wrapAndDepositManyTx } from "@/lib/near/wrap";
import { _resetStore } from "@/lib/orders/store";

const ADDR = "0xb22bd3998c0A140830DE119a8Be96602a1242e74";

describe("wrapAndDepositManyTx", () => {
  it("funds several deposit addresses in one transaction", () => {
    const tx = wrapAndDepositManyTx([
      { depositAddress: "a", amountYocto: "100" },
      { depositAddress: "b", amountYocto: "30" },
    ]);
    expect(tx.receiverId).toBe("wrap.near");
    expect(tx.actions.map((a) => a.params.methodName)).toEqual(["storage_deposit", "storage_deposit", "near_deposit", "ft_transfer", "ft_transfer"]);
    expect(tx.actions[2].params.deposit).toBe("130");
    expect(tx.actions[4].params.args).toEqual({ receiver_id: "b", amount: "30" });
  });
});

describe("add funds", () => {
  let now = new Date("2026-11-12T09:00:00Z");
  let status: Record<string, SwapStatus> = {};
  const q = (dep: string, amountIn: string, inF: string, outF: string, minOut: string): QuoteResponse =>
    ({ quote: { depositAddress: dep, amountIn, amountInFormatted: inF, amountOutFormatted: outF, minAmountOut: minOut }, correlationId: "c" }) as unknown as QuoteResponse;
  const deps = (over: Partial<FundingDeps> & { gas?: bigint } = {}): FundingDeps => ({
    target: () => ({
      id: "polygon",
      chain: "Polygon",
      collateral: { symbol: "USDC", decimals: 6, oneClickAsset: "usdc" },
      gas: { symbol: "POL", decimals: 18, oneClickAsset: "pol", topUpYocto: "30000000000000000000000" },
      address: async () => ADDR,
      gasBalance: async () => over.gas ?? BigInt(0),
      gasWanted: async () => BigInt(2e17),
    }),
    nearPriceUsd: async () => 3.5,
    requestQuote: async (r) =>
      r.destinationAsset === "pol" ? q("gasdep", r.amount, "0.03", "1.09", "1") : q("usdcdep", r.amount, "1.428572", "4.98", "4930000"),
    getStatus: async (d) => ({ status: status[d] ?? "PENDING_DEPOSIT" }),
    submitDeposit: vi.fn(async () => undefined),
    now: () => now,
    ...over,
  });

  beforeEach(() => {
    process.env.ONEBOOK_DB = ":memory:";
    _resetStore();
    now = new Date("2026-11-12T09:00:00Z");
    status = {};
  });
  afterEach(() => _resetStore());

  it("delivers USDC and gas in one approval, then finishes when both land", async () => {
    const d = deps();
    const { funding, tx } = await startFunding("alice.near", "polygon", 5, d);
    expect(funding.legs.map((l) => [l.kind, l.depositAddress])).toEqual([["collateral", "usdcdep"], ["gas", "gasdep"]]);
    expect(tx.actions.filter((a) => a.params.methodName === "ft_transfer")).toHaveLength(2);
    expect(funding.events[0].note).toMatch(/≥ 4\.93 USDC \+ ~1\.09 POL/);

    await recordFundingDeposit(funding.id, "6aBturXByHAbVoVDBBx9xMycCGp1tpq4sxqG3bfx8mqM", d);
    expect(d.submitDeposit).toHaveBeenCalledTimes(2);
    status = { usdcdep: "SUCCESS", gasdep: "PROCESSING" };
    expect((await advanceFunding(funding.id, d))!.state).toBe("SWAPPING");
    status.gasdep = "SUCCESS";
    const done = (await advanceFunding(funding.id, d))!;
    expect(done.state).toBe("DONE");
    expect(done.events.at(-1)!.note).toMatch(/USDC delivered.*\+ POL for gas/);
  });

  it("skips the gas leg when the address already has enough", async () => {
    const { funding, tx } = await startFunding("alice.near", "polygon", 5, deps({ gas: BigInt(1e18) }));
    expect(funding.legs.map((l) => l.kind)).toEqual(["collateral"]);
    expect(tx.actions.map((a) => a.params.methodName)).toEqual(["storage_deposit", "near_deposit", "ft_transfer"]);
  });

  it("fails when the USDC leg is refunded, expires without a deposit, and enforces the cap", async () => {
    const d = deps({ gas: BigInt(1e18) });
    const a = (await startFunding("alice.near", "polygon", 5, d)).funding;
    await recordFundingDeposit(a.id, "6aBturXByHAbVoVDBBx9xMycCGp1tpq4sxqG3bfx8mqM", d);
    status = { usdcdep: "REFUNDED" };
    expect((await advanceFunding(a.id, d))!.state).toBe("FAILED");

    status = {};
    const b = (await startFunding("alice.near", "polygon", 5, d)).funding;
    now = new Date(now.getTime() + 21 * 60_000);
    expect((await advanceFunding(b.id, d))!.state).toBe("EXPIRED");

    await expect(startFunding("alice.near", "polygon", 50, d)).rejects.toThrow(/demo limit/);
  });
});
