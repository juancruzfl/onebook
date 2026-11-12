"use client";

import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@/components/WalletProvider";
import type { Withdrawal, WithdrawState } from "@/lib/withdraw/engine";

interface FundsInfo {
  evmAddress: string;
  usdc: string;
  pol: string;
  needsGas: boolean;
}

const FINAL: WithdrawState[] = ["DONE", "FAILED", "ERROR"];
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const usd = (units: string) => `$${(Number(units) / 1e6).toFixed(2)}`;

const STEPS: { label: string; doneAt: WithdrawState[] }[] = [
  { label: "Add gas to your Polygon address (first time only)", doneAt: ["READY_TO_SIGN", "AWAITING_SIGNATURE", "AWAITING_SWAP", "DONE"] },
  { label: "Sign the withdrawal with your NEAR account", doneAt: ["AWAITING_SWAP", "DONE"] },
  { label: "Swap USDC to NEAR (NEAR Intents)", doneAt: ["DONE"] },
];
const ACTIVE: Partial<Record<WithdrawState, number>> = { NEEDS_GAS: 0, AWAITING_GAS: 0, READY_TO_SIGN: 1, AWAITING_SIGNATURE: 1, AWAITING_SWAP: 2 };

/** "Funds" in the nav: what sits at the user's Polygon address, and a withdraw-to-NEAR flow. */
export function Funds() {
  const { accountId, signAndSend } = useWallet();
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<FundsInfo | null>(null);
  const [w, setW] = useState<Withdrawal | null>(null);
  const [gasTx, setGasTx] = useState<{ receiverId: string; actions: unknown[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const api = useCallback(async (url: string, body?: unknown) => {
    const res = await fetch(url, body !== undefined ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json;
  }, []);

  const refresh = useCallback(async () => {
    if (!accountId) return setInfo(null);
    try {
      setInfo(await api(`/api/funds?account=${encodeURIComponent(accountId)}`));
    } catch {
      /* keep last */
    }
  }, [accountId, api]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  // Poll an active withdrawal.
  useEffect(() => {
    if (!w || FINAL.includes(w.state) || w.state === "NEEDS_GAS" || w.state === "READY_TO_SIGN") return;
    const t = setInterval(async () => {
      try {
        const next = (await api(`/api/withdrawals/${w.id}`)).withdrawal as Withdrawal;
        setW(next);
        if (FINAL.includes(next.state)) refresh();
      } catch {
        /* retry */
      }
    }, 3000);
    return () => clearInterval(t);
  }, [w, api, refresh]);

  if (!accountId) return null;

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const start = () =>
    run("Checking your funds…", async () => {
      const r = await api("/api/withdrawals", { account: accountId });
      setW(r.withdrawal);
      setGasTx(r.gasTx ?? null);
    });

  const addGas = () =>
    run("Approve the gas deposit in your wallet…", async () => {
      if (!w || !gasTx) return;
      const { txHash } = await signAndSend(gasTx);
      if (!txHash) throw new Error("wallet did not return a transaction hash");
      setW((await api(`/api/withdrawals/${w.id}/gas`, { txHash })).withdrawal);
    });

  const signWithdrawal = () =>
    run("Preparing the withdrawal…", async () => {
      if (!w) return;
      const prep = await api(`/api/withdrawals/${w.id}/prepare`, {});
      setW(prep.withdrawal);
      setBusy("Approve the signature in your wallet…");
      const { result, txHash } = await signAndSend(prep.signTx);
      setBusy("Sending on Polygon…");
      setW((await api(`/api/withdrawals/${w.id}/signed`, { mpcResult: result, txHash })).withdrawal);
    });

  const hasUsdc = info && BigInt(info.usdc) > BigInt(0);
  const current = w ? ACTIVE[w.state] : undefined;
  const failed = w && (w.state === "FAILED" || w.state === "ERROR");

  return (
    <>
      <button className="chip-btn" onClick={() => (setOpen(true), refresh())} title="Funds at your Polygon address">
        Funds {info ? usd(info.usdc) : ""}
      </button>
      {open && (
        <div className="sheet-backdrop" onClick={() => !busy && setOpen(false)}>
          <aside className="sheet" role="dialog" aria-label="Your funds" onClick={(e) => e.stopPropagation()}>
            <header className="sheet-head">
              <div className="mcard-title">
                <h3>Your funds</h3>
                {info && (
                  <span className="muted small">
                    Polygon address{" "}
                    <a href={`https://polygonscan.com/address/${info.evmAddress}`} target="_blank" rel="noreferrer">
                      {short(info.evmAddress)} ↗
                    </a>
                    , controlled by {accountId}
                  </span>
                )}
              </div>
              <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Close" disabled={!!busy}>
                ×
              </button>
            </header>

            <section className="quote-box">
              <div className="kv big">
                <span>USDC</span>
                <strong>{info ? usd(info.usdc) : "…"}</strong>
              </div>
              <div className="kv">
                <span>POL (for gas)</span>
                <strong>{info ? (Number(info.pol) / 1e18).toFixed(4) : "…"}</strong>
              </div>
              <p className="muted tiny">
                Unspent USDC from orders stays here, at an address only your NEAR account can sign for. Withdraw sends it
                back to {accountId} as NEAR.
              </p>
            </section>

            {w && (
              <ol className="flow-steps">
                {STEPS.map((s, i) => {
                  const done = s.doneAt.includes(w.state);
                  return (
                    <li key={s.label} className={done ? "done" : current === i ? (failed ? "fail" : "active") : ""}>
                      <span className="flow-dot" />
                      <span>{s.label}</span>
                    </li>
                  );
                })}
              </ol>
            )}

            {!w || FINAL.includes(w.state) ? (
              <button className="cta yes" onClick={start} disabled={!hasUsdc || !!busy}>
                {busy ?? (hasUsdc ? `Withdraw ${usd(info!.usdc)} to NEAR` : "Nothing to withdraw")}
              </button>
            ) : w.state === "NEEDS_GAS" ? (
              <>
                <p className="muted small">
                  Your Polygon address needs a little POL to pay the network fee. Deposit {w.gas?.amountInFormatted} NEAR
                  (about $0.10); NEAR Intents delivers ~{Number(w.gas?.amountOutFormatted ?? 0).toFixed(2)} POL, enough for many
                  withdrawals.
                </p>
                <button className="cta yes" onClick={addGas} disabled={!!busy}>
                  {busy ?? `Add gas · ${w.gas?.amountInFormatted} NEAR`}
                </button>
              </>
            ) : w.state === "READY_TO_SIGN" || w.state === "AWAITING_SIGNATURE" ? (
              <>
                <p className="muted small">
                  Your NEAR account signs a USDC transfer from your Polygon address to NEAR Intents, which swaps it to NEAR
                  and sends it to {accountId}. If the swap fails, the USDC comes back to your Polygon address.
                </p>
                <button className="cta yes" onClick={signWithdrawal} disabled={!!busy}>
                  {busy ?? "Sign withdrawal"}
                </button>
              </>
            ) : (
              <p className="muted small">{w.state === "AWAITING_GAS" ? "Waiting for gas to arrive (~30 s)…" : "Swapping to NEAR (~30-60 s)…"}</p>
            )}
            {busy && w && <p className="muted small">{busy}</p>}
            {error && <p className="err-text small">{error}</p>}

            {w && w.events.length > 0 && (
              <ul className="flow-log">
                {w.events
                  .slice()
                  .reverse()
                  .map((e) => (
                    <li key={e.at + e.state}>
                      <span className="muted tiny">{new Date(e.at).toLocaleTimeString()}</span> {e.note}
                    </li>
                  ))}
              </ul>
            )}
            {w?.tx?.polygonTxHash && (
              <p className="tiny">
                <a href={`https://polygonscan.com/tx/${w.tx.polygonTxHash}`} target="_blank" rel="noreferrer">
                  Polygon transfer ↗
                </a>
                {w.swap && (
                  <>
                    {" · "}
                    <a href={`https://explorer.near-intents.org/?depositAddress=${w.swap.depositAddress}`} target="_blank" rel="noreferrer">
                      Track swap ↗
                    </a>
                  </>
                )}
              </p>
            )}
          </aside>
        </div>
      )}
    </>
  );
}
