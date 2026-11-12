/**
 * Withdraw: USDC at the user's Chain Signatures address on Polygon → NEAR in the user's NEAR account.
 * Server-only. Same custody rule as the buy flow: funds only move between addresses the user controls
 * and 1Click deposit addresses; refunds go back to the user.
 *
 *   NEEDS_GAS           the Polygon address has no POL for the transfer fee. The user deposits a little
 *                       NEAR (GAS_TOPUP_YOCTO) and 1Click delivers POL to the Polygon address.
 *   AWAITING_GAS        gas deposit sent; waiting for POL to arrive
 *   READY_TO_SIGN       enough POL; the user can start the withdrawal
 *   AWAITING_SIGNATURE  1Click quote (USDC → NEAR, recipient = NEAR account, refund = Polygon address) and
 *                       an unsigned USDC.transfer(depositAddress) built; the user signs it via v1.signer
 *   AWAITING_SWAP       signed transfer broadcast on Polygon and reported to 1Click; waiting for SUCCESS
 *   DONE                final: NEAR delivered to the user's account
 *   FAILED              final: transfer reverted or swap refunded (USDC returns to the Polygon address)
 *   ERROR               final: unexpected failure (see events)
 */
import { randomUUID } from "node:crypto";
import type { Address, Hex } from "viem";
import {
  broadcast,
  buildUsdcTransfer,
  polBalance,
  receiptStatus,
  signedTransaction,
  transferGasCost,
  txSigningHash,
  usdcBalance,
  type UnsignedTxJson,
} from "@/lib/chains/polygon";
import { ASSETS, getStatus, requestQuote, submitDeposit, type QuoteRequest, type QuoteResponse, type StatusResponse } from "@/lib/intents/oneclick";
import { deriveEvmAddress } from "@/lib/near/chainsig";
import { mpcResultToEvmSignature, mpcSignTx, type MpcSignTx } from "@/lib/near/mpc";
import { wrapAndDepositTx } from "@/lib/near/wrap";
import { openDb } from "@/lib/orders/store";
import { QuoteError } from "@/lib/quote";

/** POL (Polygon native token) on 1Click. */
export const POL_ASSET = "nep141:pol.omdep.near";
/** 0.03 NEAR of POL: ~1 POL, enough for dozens of transfers. */
export const GAS_TOPUP_YOCTO = "30000000000000000000000";
/** Sign within this window, or the withdrawal goes back to READY_TO_SIGN with a fresh quote. */
const SIGN_TTL_MS = 10 * 60 * 1000;

export type WithdrawState =
  | "NEEDS_GAS"
  | "AWAITING_GAS"
  | "READY_TO_SIGN"
  | "AWAITING_SIGNATURE"
  | "AWAITING_SWAP"
  | "DONE"
  | "FAILED"
  | "ERROR";
export const ACTIVE_WITHDRAW: WithdrawState[] = ["AWAITING_GAS", "AWAITING_SIGNATURE", "AWAITING_SWAP"];

export interface Withdrawal {
  id: string;
  account: string;
  evmAddress: Address;
  createdAt: string;
  updatedAt: string;
  state: WithdrawState;
  /** USDC (6 dp) being withdrawn, fixed when the transfer is built. */
  usdcAmount?: string;
  gas?: { depositAddress: string; amountInFormatted: string; amountOutFormatted: string; depositTxHash?: string; status?: string };
  swap?: {
    depositAddress: string;
    amountInFormatted: string;
    amountOutFormatted: string;
    minAmountOut: string;
    correlationId: string;
    status?: string;
  };
  tx?: { unsigned: UnsignedTxJson; hash: Hex; signExpiresAt: string; polygonTxHash?: Hex; nearSignTx?: string };
  events: { at: string; state: WithdrawState; note: string }[];
}

export interface WithdrawDeps {
  deriveEvmAddress: (account: string) => Promise<{ address: Address }>;
  usdcBalance: (a: Address) => Promise<bigint>;
  polBalance: (a: Address) => Promise<bigint>;
  transferGasCost: () => Promise<bigint>;
  buildUsdcTransfer: (from: Address, to: Address, amount: bigint) => Promise<UnsignedTxJson>;
  signedTransaction: (j: UnsignedTxJson, sig: Hex, from: Address) => Promise<Hex>;
  broadcast: (raw: Hex) => Promise<Hex>;
  receiptStatus: (h: Hex) => Promise<"success" | "reverted" | "pending">;
  requestQuote: (q: QuoteRequest) => Promise<QuoteResponse>;
  getStatus: (depositAddress: string) => Promise<StatusResponse>;
  submitDeposit: (depositAddress: string, txHash: string) => Promise<void>;
  now: () => Date;
}

export const defaultWithdrawDeps: WithdrawDeps = {
  deriveEvmAddress: (a) => deriveEvmAddress(a, "mainnet"),
  usdcBalance,
  polBalance,
  transferGasCost,
  buildUsdcTransfer,
  signedTransaction,
  broadcast,
  receiptStatus,
  requestQuote,
  getStatus,
  submitDeposit,
  now: () => new Date(),
};

// ---------------------------------------------------------------- store

function table() {
  const db = openDb();
  db.exec(`CREATE TABLE IF NOT EXISTS withdrawals (
    id TEXT PRIMARY KEY, state TEXT NOT NULL, account TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL)`);
  return db;
}
function save(w: Withdrawal) {
  table()
    .prepare(
      `INSERT INTO withdrawals (id, state, account, created_at, data) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET state = excluded.state, data = excluded.data`,
    )
    .run(w.id, w.state, w.account, w.createdAt, JSON.stringify(w));
}
export function getWithdrawal(id: string): Withdrawal | null {
  const row = table().prepare("SELECT data FROM withdrawals WHERE id = ?").get(id) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as Withdrawal) : null;
}
function listActive(): Withdrawal[] {
  const qs = ACTIVE_WITHDRAW.map(() => "?").join(",");
  return (table().prepare(`SELECT data FROM withdrawals WHERE state IN (${qs}) LIMIT 50`).all(...ACTIVE_WITHDRAW) as { data: string }[]).map(
    (r) => JSON.parse(r.data) as Withdrawal,
  );
}

function step(w: Withdrawal, state: WithdrawState, note: string, now: Date): Withdrawal {
  const at = now.toISOString();
  return { ...w, state, updatedAt: at, events: [...w.events, { at, state, note }] };
}
const fmt6 = (u: bigint) => (Number(u) / 1e6).toFixed(2);

// ---------------------------------------------------------------- balances

export async function funds(account: string, deps: WithdrawDeps = defaultWithdrawDeps) {
  const { address } = await deps.deriveEvmAddress(account);
  const [usdc, pol, gasCost] = await Promise.all([deps.usdcBalance(address), deps.polBalance(address), deps.transferGasCost()]);
  return { evmAddress: address, usdc: usdc.toString(), pol: pol.toString(), gasCost: gasCost.toString(), needsGas: pol < gasCost };
}

// ---------------------------------------------------------------- start

/** Start a withdrawal. Returns the gas-top-up NEAR transaction when the address has no POL yet. */
export async function startWithdrawal(account: string, deps: WithdrawDeps = defaultWithdrawDeps): Promise<{ withdrawal: Withdrawal; gasTx?: ReturnType<typeof wrapAndDepositTx> }> {
  const f = await funds(account, deps);
  if (BigInt(f.usdc) === BigInt(0)) throw new QuoteError("nothing to withdraw: no USDC at your Polygon address", 400);
  const now = deps.now();
  const base: Withdrawal = {
    id: randomUUID(),
    account,
    evmAddress: f.evmAddress,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    state: "READY_TO_SIGN",
    events: [],
  };
  if (!f.needsGas) {
    const w = step(base, "READY_TO_SIGN", `${fmt6(BigInt(f.usdc))} USDC available; gas already covered`, now);
    save(w);
    return { withdrawal: w };
  }
  const q = await deps.requestQuote({
    dry: false,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: ASSETS.wNEAR,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: POL_ASSET,
    amount: GAS_TOPUP_YOCTO,
    recipient: f.evmAddress,
    recipientType: "DESTINATION_CHAIN",
    refundTo: account,
    refundType: "ORIGIN_CHAIN",
    deadline: new Date(now.getTime() + 30 * 60_000).toISOString(),
  });
  const depositAddress = q.quote.depositAddress;
  if (!depositAddress) throw new Error("1Click returned no deposit address");
  const w = step(
    {
      ...base,
      gas: { depositAddress, amountInFormatted: q.quote.amountInFormatted, amountOutFormatted: q.quote.amountOutFormatted },
    },
    "NEEDS_GAS",
    `Your Polygon address needs gas: ${q.quote.amountInFormatted} NEAR → ~${Number(q.quote.amountOutFormatted).toFixed(2)} POL`,
    now,
  );
  save(w);
  return { withdrawal: w, gasTx: wrapAndDepositTx(depositAddress, GAS_TOPUP_YOCTO) };
}

export async function recordGasDeposit(id: string, txHash: string, deps: WithdrawDeps = defaultWithdrawDeps): Promise<Withdrawal> {
  const w = getWithdrawal(id);
  if (!w || w.state !== "NEEDS_GAS" || !w.gas) throw new QuoteError("withdrawal is not waiting for a gas deposit", 409);
  await deps.submitDeposit(w.gas.depositAddress, txHash);
  const next = step({ ...w, gas: { ...w.gas, depositTxHash: txHash } }, "AWAITING_GAS", `Gas deposit sent (${txHash.slice(0, 10)}…)`, deps.now());
  save(next);
  return next;
}

// ---------------------------------------------------------------- sign

/** Quote USDC → NEAR and build the Polygon transfer; returns the v1.signer transaction for the wallet. */
export async function prepareTransfer(id: string, deps: WithdrawDeps = defaultWithdrawDeps): Promise<{ withdrawal: Withdrawal; signTx: MpcSignTx }> {
  const w = getWithdrawal(id);
  if (!w || (w.state !== "READY_TO_SIGN" && w.state !== "AWAITING_SIGNATURE")) throw new QuoteError("withdrawal is not ready to sign", 409);
  const amount = await deps.usdcBalance(w.evmAddress);
  if (amount === BigInt(0)) throw new QuoteError("nothing to withdraw: no USDC at your Polygon address", 400);
  const now = deps.now();
  const q = await deps.requestQuote({
    dry: false,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: ASSETS.USDC_POLYGON,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: ASSETS.wNEAR,
    amount: amount.toString(),
    recipient: w.account,
    recipientType: "DESTINATION_CHAIN",
    refundTo: w.evmAddress,
    refundType: "ORIGIN_CHAIN",
    deadline: new Date(now.getTime() + 60 * 60_000).toISOString(),
  });
  const depositAddress = q.quote.depositAddress as Address | undefined;
  if (!depositAddress || !/^0x[0-9a-fA-F]{40}$/.test(depositAddress)) throw new Error("1Click returned no Polygon deposit address");
  const unsigned = await deps.buildUsdcTransfer(w.evmAddress, depositAddress, amount);
  const hash = txSigningHash(unsigned);
  const next = step(
    {
      ...w,
      usdcAmount: amount.toString(),
      swap: {
        depositAddress,
        amountInFormatted: q.quote.amountInFormatted,
        amountOutFormatted: q.quote.amountOutFormatted,
        minAmountOut: q.quote.minAmountOut,
        correlationId: q.correlationId,
      },
      tx: { unsigned, hash, signExpiresAt: new Date(now.getTime() + SIGN_TTL_MS).toISOString() },
    },
    "AWAITING_SIGNATURE",
    `Quote: ${q.quote.amountInFormatted} USDC → ~${Number(q.quote.amountOutFormatted).toFixed(4)} NEAR to ${w.account}`,
    now,
  );
  save(next);
  return { withdrawal: next, signTx: mpcSignTx(hash) };
}

/** Attach the MPC signature, broadcast the Polygon transfer and hand the deposit to 1Click. */
export async function recordTransferSignature(
  id: string,
  mpcResult: unknown,
  nearTxHash: string | undefined,
  deps: WithdrawDeps = defaultWithdrawDeps,
): Promise<Withdrawal> {
  const w = getWithdrawal(id);
  if (!w || w.state !== "AWAITING_SIGNATURE" || !w.tx || !w.swap) throw new QuoteError("withdrawal is not waiting for a signature", 409);
  if (deps.now() > new Date(w.tx.signExpiresAt)) throw new QuoteError("this withdrawal quote expired; start it again", 410);
  const raw = await deps.signedTransaction(w.tx.unsigned, mpcResultToEvmSignature(mpcResult), w.evmAddress);
  const polygonTxHash = await deps.broadcast(raw);
  await deps.submitDeposit(w.swap.depositAddress, polygonTxHash);
  const next = step(
    { ...w, tx: { ...w.tx, polygonTxHash, nearSignTx: nearTxHash } },
    "AWAITING_SWAP",
    `Signed by your NEAR account and sent on Polygon (${polygonTxHash.slice(0, 10)}…)`,
    deps.now(),
  );
  save(next);
  return next;
}

// ---------------------------------------------------------------- queue

const inFlight = new Set<string>();

export async function advanceWithdrawal(id: string, deps: WithdrawDeps = defaultWithdrawDeps): Promise<Withdrawal | null> {
  const w = getWithdrawal(id);
  if (!w || !ACTIVE_WITHDRAW.includes(w.state) || inFlight.has(id)) return w;
  inFlight.add(id);
  try {
    const now = deps.now();
    let next: Withdrawal | null = null;
    if (w.state === "AWAITING_GAS" && w.gas) {
      const [pol, cost] = await Promise.all([deps.polBalance(w.evmAddress), deps.transferGasCost()]);
      if (pol >= cost) next = step(w, "READY_TO_SIGN", `Gas arrived (${(Number(pol) / 1e18).toFixed(3)} POL)`, now);
      else {
        const st = await deps.getStatus(w.gas.depositAddress);
        if (st.status === "REFUNDED" || st.status === "FAILED")
          next = step({ ...w, gas: { ...w.gas, status: st.status } }, "ERROR", `Gas top-up ${st.status.toLowerCase()}; NEAR returned to ${w.account}`, now);
      }
    } else if (w.state === "AWAITING_SIGNATURE" && w.tx && now > new Date(w.tx.signExpiresAt)) {
      next = step({ ...w, tx: undefined, swap: undefined }, "READY_TO_SIGN", "Quote expired before signing; nothing moved", now);
    } else if (w.state === "AWAITING_SWAP" && w.swap && w.tx?.polygonTxHash) {
      if ((await deps.receiptStatus(w.tx.polygonTxHash)) === "reverted")
        next = step(w, "FAILED", "Polygon transfer reverted; your USDC did not move", now);
      else {
        const st = await deps.getStatus(w.swap.depositAddress);
        const withStatus = st.status !== w.swap.status ? { ...w, swap: { ...w.swap, status: st.status } } : null;
        if (st.status === "SUCCESS") next = step(withStatus ?? w, "DONE", `NEAR delivered to ${w.account}`, now);
        else if (st.status === "REFUNDED" || st.status === "FAILED" || st.status === "INCOMPLETE_DEPOSIT")
          next = step(withStatus ?? w, "FAILED", `Swap ${st.status.toLowerCase()}; USDC returns to your Polygon address`, now);
        else next = withStatus;
      }
    }
    if (next) save(next);
    return next ?? w;
  } catch (e) {
    console.warn(`[withdraw] advance ${id} failed:`, (e as Error).message);
    return w;
  } finally {
    inFlight.delete(id);
  }
}

export async function tickWithdrawals(deps: WithdrawDeps = defaultWithdrawDeps): Promise<void> {
  for (const w of listActive()) await advanceWithdrawal(w.id, deps);
}
