"use client";

import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@/components/WalletProvider";
import type { OrderRecord, OrderState } from "@/lib/orders/types";
import type { Side, VenueId } from "@/lib/venues/types";

interface NearTx {
  receiverId: string;
  actions: unknown[];
}

const FINAL: OrderState[] = ["ORDER_DRY_RUN", "SWAP_FAILED", "EXPIRED", "ERROR"];

const BALANCE_STEPS: { key: string; label: string; doneAt: OrderState[] }[] = [
  { key: "sign", label: "Sign the order with your NEAR account", doneAt: ["SWAP_SETTLED", "ORDER_DRY_RUN"] },
  { key: "order", label: "Place order on Polymarket (dry run)", doneAt: ["ORDER_DRY_RUN"] },
];

const STEPS: { key: string; label: string; doneAt: OrderState[] }[] = [
  { key: "sign", label: "Sign the order with your NEAR account", doneAt: ["AWAITING_DEPOSIT_TX", "AWAITING_SWAP", "SWAP_SETTLED", "ORDER_DRY_RUN"] },
  { key: "deposit", label: "Deposit NEAR", doneAt: ["AWAITING_SWAP", "SWAP_SETTLED", "ORDER_DRY_RUN"] },
  { key: "swap", label: "Swap to USDC on Polygon (NEAR Intents)", doneAt: ["SWAP_SETTLED", "ORDER_DRY_RUN"] },
  { key: "order", label: "Place order on Polymarket (dry run)", doneAt: ["ORDER_DRY_RUN"] },
];

const activeStep: Partial<Record<OrderState, string>> = {
  AWAITING_SIGNATURE: "sign",
  AWAITING_DEPOSIT_TX: "deposit",
  AWAITING_SWAP: "swap",
  SWAP_SETTLED: "order",
};

/**
 * Executes the Polymarket leg of a route: prepare → wallet signs order (MPC) → user confirms deposit →
 * queue tracks the swap → dry-run order. Each wallet prompt is a separate, explicit click.
 */
export function OrderFlow({
  markets,
  side,
  budgetUsd,
  allowNearEquivalent,
  fromBalance,
  onClose,
}: {
  markets: { venue: VenueId; marketId: string }[];
  side: Side;
  budgetUsd: number;
  allowNearEquivalent: boolean;
  /** The user's trading balance covers this order: expect sign-and-done (the server decides). */
  fromBalance?: boolean;
  onClose: () => void;
}) {
  const { accountId, signAndSend } = useWallet();
  const [order, setOrder] = useState<OrderRecord | null>(null);
  const [deposit, setDeposit] = useState<NearTx | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const api = useCallback(async (url: string, body?: unknown) => {
    const res = await fetch(url, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json;
  }, []);

  // 1. Prepare + sign (no funds move).
  async function prepareAndSign() {
    if (!accountId) return;
    setError(null);
    try {
      setBusy("Preparing your order…");
      const prep = await api("/api/orders", { account: accountId, markets, side, budgetUsd, allowNearEquivalent });
      setOrder(prep.order);
      setDeposit(prep.nearTxs.deposit ?? null);
      setBusy("Approve the signature in your wallet…");
      const { result, txHash } = await signAndSend(prep.nearTxs.sign);
      setBusy("Verifying signature…");
      const signed = await api(`/api/orders/${prep.order.id}/signed`, { mpcResult: result, txHash });
      setOrder(signed.order);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  // 2. Deposit (moves NEAR to the 1Click deposit address).
  async function sendDeposit() {
    if (!order || !deposit) return;
    setError(null);
    try {
      setBusy("Approve the deposit in your wallet…");
      const { txHash } = await signAndSend(deposit);
      if (!txHash) throw new Error("wallet did not return a transaction hash");
      const dep = await api(`/api/orders/${order.id}/deposited`, { txHash });
      setOrder(dep.order);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  // 3. Poll the queue until a final state.
  useEffect(() => {
    if (!order || FINAL.includes(order.state) || order.state === "AWAITING_SIGNATURE") return;
    const t = setInterval(async () => {
      try {
        setOrder((await api(`/api/orders/${order.id}`)).order);
      } catch {
        /* retry next tick */
      }
    }, 3000);
    return () => clearInterval(t);
  }, [order, api]);

  const paidFromBalance = order ? order.funding === "balance" : !!fromBalance;
  const steps = paidFromBalance ? BALANCE_STEPS : STEPS;
  const current = order ? activeStep[order.state] : undefined;
  const failed = order && ["SWAP_FAILED", "EXPIRED", "ERROR"].includes(order.state);

  return (
    <section className="order-flow" aria-live="polite">
      <header className="row" style={{ justifyContent: "space-between" }}>
        <strong>Execute Polymarket leg</strong>
        <button className="link" onClick={onClose} disabled={!!busy}>
          {order && FINAL.includes(order.state) ? "Done" : "Cancel"}
        </button>
      </header>

      {order && (
        <div className="kv small">
          <span>Order</span>
          <strong>
            {order.shares} {order.market.outcome} @ ≤ {(order.limitPrice * 100).toFixed(0)}¢
          </strong>
        </div>
      )}
      {order && (
        <div className="kv small">
          <span>{order.swap ? "You deposit" : "Paid from"}</span>
          <strong>{order.swap ? `${order.swap.amountInFormatted} NEAR` : `your balance · ${(Number(order.usdcAmount) / 1e6).toFixed(2)} USDC`}</strong>
        </div>
      )}

      <ol className="flow-steps">
        {steps.map((s) => {
          const done = order ? s.doneAt.includes(order.state) : false;
          const active = current === s.key;
          return (
            <li key={s.key} className={done ? "done" : active ? (failed ? "fail" : "active") : ""}>
              <span className="flow-dot" />
              <span>{s.label}</span>
            </li>
          );
        })}
      </ol>

      {!order && (
        <>
          <p className="muted small">
            {paidFromBalance
              ? "Paid from the USDC already at your Polygon address: one signature and you're done."
              : "Your NEAR account signs the order first; nothing is spent until you approve the deposit in the next step."}
          </p>
          <button className="cta yes" onClick={prepareAndSign} disabled={!!busy}>
            {busy ?? "Sign order"}
          </button>
        </>
      )}
      {order?.state === "AWAITING_SIGNATURE" && !busy && (
        <button className="cta yes" onClick={prepareAndSign}>
          Retry signing
        </button>
      )}
      {order?.state === "AWAITING_DEPOSIT_TX" && order.swap && (
        <>
          <p className="muted small">
            Order signed ✓. Deposit {order.swap.amountInFormatted} NEAR; NEAR Intents swaps it to at least{" "}
            {(Number(order.swap.minAmountOut) / 1e6).toFixed(2)} USDC at your Polygon address{" "}
            <code>{order.evmAddress.slice(0, 6)}…{order.evmAddress.slice(-4)}</code>. If the swap fails, the NEAR is refunded.
          </p>
          <button className="cta yes" onClick={sendDeposit} disabled={!!busy}>
            {busy ?? `Deposit ${order.swap.amountInFormatted} NEAR`}
          </button>
        </>
      )}
      {busy && order && order.state !== "AWAITING_DEPOSIT_TX" && <p className="muted small">{busy}</p>}
      {error && <p className="err-text small">{error}</p>}

      {order && order.events.length > 0 && (
        <ul className="flow-log">
          {order.events
            .slice()
            .reverse()
            .map((e) => (
              <li key={e.at + e.state}>
                <span className="muted tiny">{new Date(e.at).toLocaleTimeString()}</span> {e.note}
              </li>
            ))}
        </ul>
      )}
      {(order?.swap?.depositTxHash || (order?.funding === "balance" && order.state === "ORDER_DRY_RUN")) && (
        <p className="tiny">
          {order?.swap && (
            <>
              <a href={`https://explorer.near-intents.org/?depositAddress=${order.swap.depositAddress}`} target="_blank" rel="noreferrer">
                Track swap on NEAR Intents Explorer ↗
              </a>
              {" · "}
            </>
          )}
          <a href={`https://polygonscan.com/address/${order!.evmAddress}`} target="_blank" rel="noreferrer">
            Your Polygon address ↗
          </a>
        </p>
      )}
    </section>
  );
}
