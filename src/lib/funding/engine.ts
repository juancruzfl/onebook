/**
 * Add funds: NEAR → a venue's collateral (plus gas when low) at the user's Chain Signatures address on
 * that venue's chain, through NEAR Intents, in ONE wallet approval. Server-only.
 *
 *   AWAITING_DEPOSIT  quotes made; the wallet sends one wrap.near tx funding every leg's deposit address
 *   SWAPPING          1Click is delivering each leg (collateral, gas)
 *   DONE              final: collateral delivered (gas leg too, or noted if it failed)
 *   FAILED            final: collateral leg refunded / failed; NEAR goes back to the user's account
 *   EXPIRED           final: no deposit within the window; nothing moved
 */
import { randomUUID } from "node:crypto";
import type { Address } from "viem";
import { ASSETS, getStatus, requestQuote, submitDeposit, tokenPriceUsd, type QuoteRequest, type QuoteResponse, type StatusResponse } from "@/lib/intents/oneclick";
import { wrapAndDepositManyTx } from "@/lib/near/wrap";
import { openDb } from "@/lib/orders/store";
import { QuoteError } from "@/lib/quote";
import { TARGETS, type FundingTarget, type TargetId } from "@/lib/funding/targets";

/** Per-deposit cap while this is a demo (same default as MAX_ORDER_USD). Never raise without approval. */
export const MAX_FUND_USD = Number(process.env.MAX_FUND_USD ?? process.env.MAX_ORDER_USD ?? 10);
const DEPOSIT_WINDOW_MS = 20 * 60 * 1000;

export type FundingState = "AWAITING_DEPOSIT" | "SWAPPING" | "DONE" | "FAILED" | "EXPIRED";
export const ACTIVE_FUNDING: FundingState[] = ["AWAITING_DEPOSIT", "SWAPPING"];

export interface FundingLeg {
  kind: "collateral" | "gas";
  asset: string;
  depositAddress: string;
  amountIn: string;
  amountInFormatted: string;
  amountOutFormatted: string;
  minAmountOut: string;
  status?: string;
}

export interface Funding {
  id: string;
  account: string;
  target: TargetId;
  address: Address;
  usd: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  state: FundingState;
  legs: FundingLeg[];
  depositTxHash?: string;
  events: { at: string; state: FundingState; note: string }[];
}

type TargetPort = Pick<FundingTarget, "id" | "chain" | "collateral" | "gas" | "address" | "gasBalance" | "gasWanted">;

export interface FundingDeps {
  target: (id: TargetId) => TargetPort;
  nearPriceUsd: () => Promise<number>;
  requestQuote: (q: QuoteRequest) => Promise<QuoteResponse>;
  getStatus: (depositAddress: string) => Promise<StatusResponse>;
  submitDeposit: (depositAddress: string, txHash: string) => Promise<void>;
  now: () => Date;
}

export const defaultFundingDeps: FundingDeps = {
  target: (id) => TARGETS[id],
  nearPriceUsd: () => tokenPriceUsd(ASSETS.wNEAR),
  requestQuote,
  getStatus,
  submitDeposit,
  now: () => new Date(),
};

// ---------------------------------------------------------------- store

function table() {
  const db = openDb();
  db.exec(`CREATE TABLE IF NOT EXISTS fundings (
    id TEXT PRIMARY KEY, state TEXT NOT NULL, account TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL)`);
  return db;
}
function save(f: Funding) {
  table()
    .prepare(
      `INSERT INTO fundings (id, state, account, created_at, data) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET state = excluded.state, data = excluded.data`,
    )
    .run(f.id, f.state, f.account, f.createdAt, JSON.stringify(f));
}
export function getFunding(id: string): Funding | null {
  const row = table().prepare("SELECT data FROM fundings WHERE id = ?").get(id) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as Funding) : null;
}
function listActive(): Funding[] {
  const qs = ACTIVE_FUNDING.map(() => "?").join(",");
  return (table().prepare(`SELECT data FROM fundings WHERE state IN (${qs}) LIMIT 50`).all(...ACTIVE_FUNDING) as { data: string }[]).map(
    (r) => JSON.parse(r.data) as Funding,
  );
}

function step(f: Funding, state: FundingState, note: string, now: Date): Funding {
  const at = now.toISOString();
  return { ...f, state, updatedAt: at, events: [...f.events, { at, state, note }] };
}

// ---------------------------------------------------------------- start

const yoctoFromNear = (near: number) => (BigInt(Math.ceil(near * 1e6)) * BigInt(10) ** BigInt(18)).toString(); // 6 dp

export async function startFunding(
  account: string,
  targetId: TargetId,
  usd: number,
  deps: FundingDeps = defaultFundingDeps,
): Promise<{ funding: Funding; tx: ReturnType<typeof wrapAndDepositManyTx> }> {
  if (!(usd > 0) || usd > MAX_FUND_USD) throw new QuoteError(`amount: $0-${MAX_FUND_USD} per deposit (demo limit)`, 400);
  const t = deps.target(targetId);
  const now = deps.now();
  const [address, price] = await Promise.all([t.address(account), deps.nearPriceUsd()]);
  const [gasHave, gasWant] = await Promise.all([t.gasBalance(address), t.gasWanted()]);
  const deadline = new Date(now.getTime() + 60 * 60_000).toISOString();
  const quote = (asset: string, amount: string) =>
    deps.requestQuote({
      dry: false,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: ASSETS.wNEAR,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: asset,
      amount,
      recipient: address,
      recipientType: "DESTINATION_CHAIN",
      refundTo: account,
      refundType: "ORIGIN_CHAIN",
      deadline,
    });

  const wantGas = gasHave < gasWant;
  const [cq, gq] = await Promise.all([
    quote(t.collateral.oneClickAsset, yoctoFromNear(usd / price)),
    wantGas ? quote(t.gas.oneClickAsset, t.gas.topUpYocto) : Promise.resolve(null),
  ]);
  const leg = (kind: FundingLeg["kind"], asset: string, q: QuoteResponse): FundingLeg => {
    if (!q.quote.depositAddress) throw new Error("1Click returned no deposit address");
    if (q.quote.depositMemo) throw new Error("deposit memos are not supported");
    return {
      kind,
      asset,
      depositAddress: q.quote.depositAddress,
      amountIn: q.quote.amountIn,
      amountInFormatted: q.quote.amountInFormatted,
      amountOutFormatted: q.quote.amountOutFormatted,
      minAmountOut: q.quote.minAmountOut,
    };
  };
  const legs = [leg("collateral", t.collateral.symbol, cq), ...(gq ? [leg("gas", t.gas.symbol, gq)] : [])];
  const totalNear = legs.reduce((s, l) => s + Number(l.amountInFormatted), 0);
  const minCollateral = Number(legs[0].minAmountOut) / 10 ** t.collateral.decimals;

  const f = step(
    {
      id: randomUUID(),
      account,
      target: targetId,
      address,
      usd,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + DEPOSIT_WINDOW_MS).toISOString(),
      state: "AWAITING_DEPOSIT",
      legs,
      events: [],
    },
    "AWAITING_DEPOSIT",
    `Quote: ${totalNear.toFixed(4)} NEAR → ≥ ${minCollateral.toFixed(2)} ${t.collateral.symbol}` +
      (gq ? ` + ~${Number(gq.quote.amountOutFormatted).toFixed(2)} ${t.gas.symbol} for gas` : "") +
      ` on ${t.chain}`,
    now,
  );
  save(f);
  return { funding: f, tx: wrapAndDepositManyTx(legs.map((l) => ({ depositAddress: l.depositAddress, amountYocto: l.amountIn }))) };
}

export async function recordFundingDeposit(id: string, txHash: string, deps: FundingDeps = defaultFundingDeps): Promise<Funding> {
  const f = getFunding(id);
  if (!f || f.state !== "AWAITING_DEPOSIT") throw new QuoteError("funding is not waiting for a deposit", 409);
  await Promise.all(f.legs.map((l) => deps.submitDeposit(l.depositAddress, txHash)));
  const next = step({ ...f, depositTxHash: txHash }, "SWAPPING", `Deposit sent (${txHash.slice(0, 10)}…)`, deps.now());
  save(next);
  return next;
}

// ---------------------------------------------------------------- queue

const FINAL_SWAP = new Set(["SUCCESS", "REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT"]);
const inFlight = new Set<string>();

export async function advanceFunding(id: string, deps: FundingDeps = defaultFundingDeps): Promise<Funding | null> {
  const f = getFunding(id);
  if (!f || !ACTIVE_FUNDING.includes(f.state) || inFlight.has(id)) return f;
  inFlight.add(id);
  try {
    const now = deps.now();
    const statuses = await Promise.all(f.legs.map((l) => deps.getStatus(l.depositAddress).then((s) => s.status)));
    const legs = f.legs.map((l, i) => ({ ...l, status: statuses[i] }));
    const changed = legs.some((l, i) => l.status !== f.legs[i].status);
    let next: Funding | null = changed ? { ...f, legs } : null;
    const cur = next ?? f;

    if (f.state === "AWAITING_DEPOSIT") {
      if (statuses.some((s) => s !== "PENDING_DEPOSIT")) next = step(cur, "SWAPPING", "Deposit detected by NEAR Intents", now);
      else if (now > new Date(f.expiresAt)) next = step(cur, "EXPIRED", "No deposit within 20 minutes; nothing moved", now);
    } else if (statuses.every((s) => FINAL_SWAP.has(s))) {
      const t = deps.target(f.target);
      const col = legs.find((l) => l.kind === "collateral")!;
      const gas = legs.find((l) => l.kind === "gas");
      if (col.status !== "SUCCESS")
        next = step(cur, "FAILED", `${t.collateral.symbol} swap ${String(col.status).toLowerCase()}; NEAR returns to ${f.account}`, now);
      else
        next = step(
          cur,
          "DONE",
          `${col.amountOutFormatted.slice(0, 6)} ${t.collateral.symbol} delivered to your ${t.chain} address` +
            (gas ? (gas.status === "SUCCESS" ? ` (+ ${t.gas.symbol} for gas)` : `; gas top-up ${String(gas.status).toLowerCase()}`) : ""),
          now,
        );
    }
    if (next) save(next);
    return next ?? f;
  } catch (e) {
    console.warn(`[funding] advance ${id} failed:`, (e as Error).message);
    return f;
  } finally {
    inFlight.delete(id);
  }
}

export async function tickFundings(deps: FundingDeps = defaultFundingDeps): Promise<void> {
  for (const f of listActive()) await advanceFunding(f.id, deps);
}
