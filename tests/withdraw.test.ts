import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseTransaction, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, sign } from "viem/accounts";
import { signedTransaction, txSigningHash, type UnsignedTxJson } from "@/lib/chains/polygon";
import type { QuoteResponse } from "@/lib/intents/oneclick";
import { _resetStore } from "@/lib/orders/store";
import {
  advanceWithdrawal,
  getWithdrawal,
  prepareTransfer,
  recordGasDeposit,
  recordTransferSignature,
  startWithdrawal,
  type WithdrawDeps,
} from "@/lib/withdraw/engine";

const pk = generatePrivateKey();
const user = privateKeyToAccount(pk);
const DEPOSIT = "0x1111111111111111111111111111111111111111" as Address;

const unsigned: UnsignedTxJson = {
  chainId: 137,
  nonce: 0,
  to: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
  data: "0xa9059cbb000000000000000000000000111111111111111111111111111111111111111100000000000000000000000000000000000000000000000000000000004de6c2",
  value: "0",
  gas: "84500",
  maxFeePerGas: "600000000000",
  maxPriorityFeePerGas: "30000000000",
};

/** The MPC contract's ECDSA result shape, produced here with a local key standing in for the MPC network. */
async function fakeMpcResult(hash: Hex) {
  const s = await sign({ hash, privateKey: pk });
  const bigR = `02${s.r.slice(2)}`;
  return { big_r: { affine_point: bigR }, s: { scalar: s.s.slice(2) }, recovery_id: Number(s.yParity) };
}

describe("signedTransaction", () => {
  it("attaches an MPC-style signature and refuses one from another key", async () => {
    const hash = txSigningHash(unsigned);
    const sig = await sign({ hash, privateKey: pk });
    const v = (Number(sig.yParity) + 27).toString(16);
    const raw = await signedTransaction(unsigned, `${sig.r}${sig.s.slice(2)}${v}` as Hex, user.address);
    const parsed = parseTransaction(raw);
    expect(parsed.to?.toLowerCase()).toBe(unsigned.to);
    expect(parsed.chainId).toBe(137);
    await expect(signedTransaction(unsigned, `${sig.r}${sig.s.slice(2)}${v}` as Hex, DEPOSIT)).rejects.toThrow(/recovers to/);
  });
});

describe("withdrawal flow", () => {
  let now = new Date("2026-11-12T09:00:00Z");
  let pol = BigInt(0);
  let swapStatus = "PENDING_DEPOSIT";
  const quote = (depositAddress: string, inF: string, outF: string): QuoteResponse =>
    ({
      quote: { depositAddress, amountIn: "0", amountInFormatted: inF, amountOutFormatted: outF, minAmountOut: "1", timeEstimate: 30 },
      correlationId: "c",
    }) as unknown as QuoteResponse;
  const deps = (over: Partial<WithdrawDeps> = {}): WithdrawDeps => ({
    deriveEvmAddress: async () => ({ address: user.address }),
    usdcBalance: async () => BigInt(5_105_282),
    polBalance: async () => pol,
    transferGasCost: async () => BigInt(3e16),
    buildUsdcTransfer: async () => unsigned,
    signedTransaction,
    broadcast: vi.fn(async () => "0xabc" as Hex),
    receiptStatus: async () => "success",
    requestQuote: async (q) =>
      q.destinationAsset === "nep141:pol.omdep.near" ? quote("gasdeposit.near", "0.03", "1.09") : quote(DEPOSIT, "5.105282", "1.4687"),
    getStatus: async () => ({ status: swapStatus as never }),
    submitDeposit: vi.fn(async () => undefined),
    now: () => now,
    ...over,
  });

  beforeEach(() => {
    process.env.ONEBOOK_DB = ":memory:";
    _resetStore();
    now = new Date("2026-11-12T09:00:00Z");
    pol = BigInt(0);
    swapStatus = "PENDING_DEPOSIT";
  });
  afterEach(() => _resetStore());

  it("tops up gas, signs the transfer with the NEAR account, and finishes when NEAR arrives", async () => {
    const d = deps();
    const { withdrawal, gasTx } = await startWithdrawal("alice.near", d);
    expect(withdrawal.state).toBe("NEEDS_GAS");
    expect(gasTx?.receiverId).toBe("wrap.near");

    await recordGasDeposit(withdrawal.id, "2m3tthjx9LD6qGA9ypHqqDbSnnot8NteCdWHs1omoQp9", d);
    expect((await advanceWithdrawal(withdrawal.id, d))!.state).toBe("AWAITING_GAS");
    pol = BigInt(1e18);
    expect((await advanceWithdrawal(withdrawal.id, d))!.state).toBe("READY_TO_SIGN");

    const { signTx, withdrawal: w2 } = await prepareTransfer(withdrawal.id, d);
    expect(w2.state).toBe("AWAITING_SIGNATURE");
    expect(signTx.receiverId).toBe("v1.signer");
    const hash = (signTx.actions[0].params.args as { request: { payload_v2: { Ecdsa: string } } }).request.payload_v2.Ecdsa;

    const w3 = await recordTransferSignature(withdrawal.id, await fakeMpcResult(`0x${hash}`), "neartx", d);
    expect(w3.state).toBe("AWAITING_SWAP");
    expect(d.broadcast).toHaveBeenCalledTimes(1);
    expect(d.submitDeposit).toHaveBeenLastCalledWith(DEPOSIT, "0xabc");

    swapStatus = "SUCCESS";
    expect((await advanceWithdrawal(withdrawal.id, d))!.state).toBe("DONE");
  });

  it("skips the gas step when the address already has POL", async () => {
    pol = BigInt(1e18);
    const { withdrawal, gasTx } = await startWithdrawal("alice.near", deps());
    expect(withdrawal.state).toBe("READY_TO_SIGN");
    expect(gasTx).toBeUndefined();
  });

  it("never broadcasts a signature from the wrong key, and expires unsigned quotes", async () => {
    pol = BigInt(1e18);
    const d = deps({ deriveEvmAddress: async () => ({ address: DEPOSIT }) });
    const { withdrawal } = await startWithdrawal("alice.near", d);
    const { signTx } = await prepareTransfer(withdrawal.id, d);
    const hash = (signTx.actions[0].params.args as { request: { payload_v2: { Ecdsa: string } } }).request.payload_v2.Ecdsa;
    await expect(recordTransferSignature(withdrawal.id, await fakeMpcResult(`0x${hash}`), undefined, d)).rejects.toThrow(/recovers to/);
    expect(d.broadcast).not.toHaveBeenCalled();

    now = new Date(now.getTime() + 11 * 60_000);
    expect((await advanceWithdrawal(withdrawal.id, d))!.state).toBe("READY_TO_SIGN");
  });

  it("reports a refunded swap and refuses empty withdrawals", async () => {
    pol = BigInt(1e18);
    const d = deps();
    const { withdrawal } = await startWithdrawal("alice.near", d);
    const { signTx } = await prepareTransfer(withdrawal.id, d);
    const hash = (signTx.actions[0].params.args as { request: { payload_v2: { Ecdsa: string } } }).request.payload_v2.Ecdsa;
    await recordTransferSignature(withdrawal.id, await fakeMpcResult(`0x${hash}`), undefined, d);
    swapStatus = "REFUNDED";
    expect((await advanceWithdrawal(withdrawal.id, d))!.state).toBe("FAILED");
    expect(getWithdrawal(withdrawal.id)!.events.at(-1)!.note).toMatch(/returns to your Polygon address/);
    await expect(startWithdrawal("alice.near", deps({ usdcBalance: async () => BigInt(0) }))).rejects.toThrow(/nothing to withdraw/);
  });
});
