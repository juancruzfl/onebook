"use client";

import { useCallback, useEffect, useState } from "react";
import { refreshFunds, useFunds } from "@/components/useFunds";
import { useWallet } from "@/components/WalletProvider";
import type { Funding, FundingState } from "@/lib/funding/engine";
import type { Withdrawal, WithdrawState } from "@/lib/withdraw/engine";

type NearTx = { receiverId: string; actions: unknown[] };

const W_FINAL: WithdrawState[] = ["DONE", "FAILED", "ERROR"];
const F_FINAL: FundingState[] = ["DONE", "FAILED", "EXPIRED"];
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const usd = (units: string) => `$${(Number(units) / 1e6).toFixed(2)}`;
const AMOUNTS = [5, 10];

const W_STEPS: { label: string; doneAt: WithdrawState[] }[] = [
  { label: "Add gas to your Polygon address (first time only)", doneAt: ["READY_TO_SIGN", "AWAITING_SIGNATURE", "AWAITING_SWAP", "DONE"] },
  { label: "Sign the withdrawal with your NEAR account", doneAt: ["AWAITING_SWAP", "DONE"] },
  { label: "Swap USDC to NEAR (NEAR Intents)", doneAt: ["DONE"] },
];
const W_ACTIVE: Partial<Record<WithdrawState, number>> = { NEEDS_GAS: 0, AWAITING_GAS: 0, READY_TO_SIGN: 1, AWAITING_SIGNATURE: 1, AWAITING_SWAP: 2 };

async function api(url: string, body?: unknown) {
  const res = await fetch(url, body !== undefined ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

/**
 * "Balance" in the nav: the trading balance at the user's Polygon address (Chain Signatures).
 * Add funds ahead of time (NEAR → USDC + gas via NEAR Intents, one approval) so trades are sign-and-done;
 * withdraw sends it back to the NEAR account.
 */
export function Funds() {
  const { accountId, signAndSend } = useWallet();
  const info = useFunds(accountId);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<Funding | null>(null);
  const [w, setW] = useState<Withdrawal | null>(null);
  const [gasTx, setGasTx] = useState<NearTx | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const poll = useCallback(
    <T extends { id: string; state: string }>(item: T | null, url: (id: string) => string, key: string, done: string[], set: (x: T) => void) => {
      if (!item || done.includes(item.state)) return;
      const t = setInterval(async () => {
        try {
          const next = (await api(url(item.id)))[key] as T;
          set(next);
          if (done.includes(next.state)) refreshFunds();
        } catch {
          /* retry */
        }
      }, 2000);
      return () => clearInterval(t);
    },
    [],
  );
  useEffect(() => {
    if (f?.state === "AWAITING_DEPOSIT") return;
    return poll(f, (id) => `/api/funding/${id}`, "funding", F_FINAL, setF);
  }, [f, poll]);
  useEffect(() => {
    if (w && (w.state === "NEEDS_GAS" || w.state === "READY_TO_SIGN")) return;
    return poll(w, (id) => `/api/withdrawals/${id}`, "withdrawal", W_FINAL, setW);
  }, [w, poll]);

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

  const addFunds = (amount: number) =>
    run("Getting a quote…", async () => {
      const r = await api("/api/funding", { account: accountId, target: "polygon", usd: amount });
      setF(r.funding);
      setBusy("Approve the deposit in your wallet…");
      const { txHash } = await signAndSend(r.tx);
      if (!txHash) throw new Error("wallet did not return a transaction hash");
      setF((await api(`/api/funding/${r.funding.id}/deposited`, { txHash })).funding);
    });

  const startWithdraw = () =>
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
  const fundingActive = f && !F_FINAL.includes(f.state);
  const withdrawActive = w && !W_FINAL.includes(w.state);
  const wCurrent = w ? W_ACTIVE[w.state] : undefined;
  const wFailed = w && (w.state === "FAILED" || w.state === "ERROR");
  const amounts = AMOUNTS.filter((a) => a <= (info?.maxFundUsd ?? 10));

  return (
    <>
      <button className="chip-btn" onClick={() => (setOpen(true), refreshFunds())} title="Trading balance at your Polygon address">
        Balance {info ? usd(info.usdc) : ""}
      </button>
      {open && (
        <div className="sheet-backdrop" onClick={() => !busy && setOpen(false)}>
          <aside className="sheet" role="dialog" aria-label="Your trading balance" onClick={(e) => e.stopPropagation()}>
            <header className="sheet-head">
              <div className="mcard-title">
                <h3>Trading balance</h3>
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
                Trades on Polymarket are paid from this balance: one signature, no swap, so you trade at the price you
                see. Add funds ahead of time; they stay at an address only your NEAR account can sign for.
              </p>
            </section>

            {/* Add funds */}
            {!withdrawActive && (
              <section className="funds-section">
                <strong className="small">Add funds</strong>
                {fundingActive ? (
                  <>
                    <p className="muted small">{f!.events.at(-1)?.note}</p>
                    <p className="muted small">
                      {f!.state === "AWAITING_DEPOSIT" ? "Waiting for your wallet…" : "NEAR Intents is delivering it (~1-2 min)…"}
                    </p>
                  </>
                ) : (
                  <>
                    {f && <p className={f.state === "DONE" ? "win small" : "err-text small"}>{f.events.at(-1)?.note}</p>}
                    <div className="chips">
                      {amounts.map((a) => (
                        <button key={a} className="chip-btn" onClick={() => addFunds(a)} disabled={!!busy}>
                          + ${a}
                        </button>
                      ))}
                    </div>
                    <p className="muted tiny">
                      Paid in NEAR in one wallet approval. NEAR Intents swaps it to USDC on Polygon
                      {info?.needsGas ? " and adds a little POL for network fees" : ""}. Max ${info?.maxFundUsd ?? 10} per
                      deposit while this is a demo.
                    </p>
                  </>
                )}
              </section>
            )}

            {/* Withdraw */}
            {!fundingActive && (
              <section className="funds-section">
                <strong className="small">Withdraw to NEAR</strong>
                {w && (
                  <ol className="flow-steps">
                    {W_STEPS.map((s, i) => (
                      <li key={s.label} className={s.doneAt.includes(w.state) ? "done" : wCurrent === i ? (wFailed ? "fail" : "active") : ""}>
                        <span className="flow-dot" />
                        <span>{s.label}</span>
                      </li>
                    ))}
                  </ol>
                )}
                {!w || W_FINAL.includes(w.state) ? (
                  <button className="chip-btn" onClick={startWithdraw} disabled={!hasUsdc || !!busy}>
                    {hasUsdc ? `Withdraw ${usd(info!.usdc)} to NEAR` : "Nothing to withdraw"}
                  </button>
                ) : w.state === "NEEDS_GAS" ? (
                  <>
                    <p className="muted small">
                      Your Polygon address needs a little POL for the network fee: {w.gas?.amountInFormatted} NEAR (about
                      $0.10) → ~{Number(w.gas?.amountOutFormatted ?? 0).toFixed(2)} POL, enough for many transactions.
                    </p>
                    <button className="cta yes" onClick={addGas} disabled={!!busy}>
                      {busy ?? `Add gas · ${w.gas?.amountInFormatted} NEAR`}
                    </button>
                  </>
                ) : w.state === "READY_TO_SIGN" || w.state === "AWAITING_SIGNATURE" ? (
                  <>
                    <p className="muted small">
                      Your NEAR account signs a USDC transfer to NEAR Intents, which swaps it to NEAR and sends it to{" "}
                      {accountId}. If the swap fails, the USDC comes back to your Polygon address.
                    </p>
                    <button className="cta yes" onClick={signWithdrawal} disabled={!!busy}>
                      {busy ?? "Sign withdrawal"}
                    </button>
                  </>
                ) : (
                  <p className="muted small">{w.state === "AWAITING_GAS" ? "Waiting for gas to arrive (~30-80 s)…" : "Swapping to NEAR (~1-2 min)…"}</p>
                )}
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
                  </p>
                )}
              </section>
            )}

            {busy && <p className="muted small">{busy}</p>}
            {error && <p className="err-text small">{error}</p>}
          </aside>
        </div>
      )}
    </>
  );
}
