"use client";

import { useEffect, useMemo, useState } from "react";
import { AssetIcon, VenueDots } from "@/components/MarketCard";
import { Countdown } from "@/components/Countdown";
import { VenueLogo } from "@/components/Logos";
import { useWallet } from "@/components/WalletProvider";
import type { MarketView } from "@/lib/market-view";
import { diffLines, fmtCents, fmtUsd, marketCopy, TIER_COPY, VENUE } from "@/lib/present";
import type { RoutePlan } from "@/lib/router";
import type { Side } from "@/lib/venues/types";

const QUICK = [5, 25, 100];

export function TradePanel({
  market,
  side,
  onSide,
  onClose,
}: {
  market: MarketView;
  side: Side;
  onSide: (s: Side) => void;
  onClose: () => void;
}) {
  const copy = marketCopy(market.spec);
  const tier = TIER_COPY[market.tier];
  const needsConsent = market.tier === "near-equivalent";
  const { accountId, connect } = useWallet();

  const [amount, setAmount] = useState("25");
  const [accepted, setAccepted] = useState(false);
  const [plan, setPlan] = useState<RoutePlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const budget = Number(amount);
  const canQuote = budget > 0 && budget <= 100_000 && (!needsConsent || accepted);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Re-quote (debounced) whenever the inputs change.
  useEffect(() => {
    setError(null);
    if (!canQuote) {
      setPlan(null);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify({
            markets: market.listings.map((l) => ({ venue: l.venue, marketId: l.marketId })),
            side,
            budgetUsd: budget,
            allowNearEquivalent: accepted,
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        setPlan(json.plan);
      } catch (e) {
        if ((e as Error).name !== "AbortError") setError((e as Error).message);
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, 400);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [market, side, budget, accepted, canQuote]);

  const reasons = useMemo(() => {
    const p = market.pairs[0];
    return p ? diffLines(p.diffs, p.a, p.b) : [];
  }, [market]);

  const label = side === "yes" ? copy.yes : copy.no;
  /** Hide a quote for the other side while the new one loads. */
  const shown = plan && plan.side === side ? plan : null;
  const unspent = shown ? Math.max(0, budget - shown.totalCost) : 0;
  

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <aside className="sheet" role="dialog" aria-label={`Trade ${copy.title}`} onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <AssetIcon asset={market.asset} size={36} />
          <div className="mcard-title">
            <h3>{copy.title}</h3>
            <span className="muted small">
              {copy.subtitle} · <Countdown to={market.closeTime} />
            </span>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <p className="question">{copy.question}</p>

        <div className="segmented" role="tablist">
          {(["yes", "no"] as const).map((s) => (
            <button
              key={s}
              role="tab"
              aria-selected={side === s}
              className={`seg ${s} ${side === s ? "active" : ""}`}
              onClick={() => onSide(s)}
            >
              {s === "yes" ? copy.yes : copy.no} {fmtCents(market.best[s]?.price)}
            </button>
          ))}
        </div>

        <label className="amount">
          <span className="muted small">Amount</span>
          <span className="amount-input">
            <span>$</span>
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
              aria-label="Amount in US dollars"
            />
          </span>
        </label>
        <div className="chips">
          {QUICK.map((q) => (
            <button key={q} className="chip-btn" onClick={() => setAmount(String((Number(amount) || 0) + q))}>
              +${q}
            </button>
          ))}
          <button className="chip-btn" onClick={() => setAmount("")}>
            Clear
          </button>
        </div>

        {needsConsent && (
          <div className="notice warn">
            <strong>{tier.label}</strong>
            <p>{tier.explain}</p>
            <ul>
              {reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            <label className="consent">
              <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />I understand
              and want to combine these venues
            </label>
          </div>
        )}

        <section className="quote-box" aria-live="polite">
          {!canQuote && !needsConsent && <p className="muted small">Enter an amount to see your best route.</p>}
          {!canQuote && needsConsent && !accepted && budget > 0 && (
            <p className="muted small">Confirm above to see your best route.</p>
          )}
          {loading && !shown && <p className="muted small">Finding the best price across venues…</p>}
          {error && <p className="err-text small">{error}</p>}
          {shown && shown.totalShares > 0 && (
            <>
              <div className="kv">
                <span>Avg price</span>
                <strong>{fmtCents(shown.avgPrice)}</strong>
              </div>
              <div className="kv">
                <span>Shares</span>
                <strong>{shown.totalShares.toFixed(2)}</strong>
              </div>
              <div className="kv big">
                <span>To win</span>
                <strong className="win">{fmtUsd(shown.totalShares)}</strong>
              </div>

              <div className="route">
                <div className="route-bar">
                  {shown.allocations.map((a) => (
                    <span
                      key={a.venue}
                      style={{ flexGrow: a.cost, background: VENUE[a.venue].color }}
                      title={`${VENUE[a.venue].name}: ${fmtUsd(a.cost)}`}
                    />
                  ))}
                </div>
                {shown.allocations.map((a) => (
                  <div key={a.venue} className="route-row">
                    <VenueLogo venue={a.venue} />
                    <span>{VENUE[a.venue].name}</span>
                    <span className="muted">
                      {fmtUsd(a.cost)} · {a.shares.toFixed(2)} @ {fmtCents(a.avgPrice)}
                    </span>
                  </div>
                ))}
              </div>

              {shown.improvementUsd > 0.005 ? (
                <p className="gain">
                  +{fmtUsd(shown.improvementUsd)} more payout than the best single venue ({VENUE[shown.bestSingleVenue!.venue].name})
                </p>
              ) : (
                <p className="muted small">
                  Best price right now is on {VENUE[shown.allocations[0].venue].name} alone.
                </p>
              )}
              {unspent > 0.01 && <p className="muted small">Not enough liquidity: {fmtUsd(unspent)} would stay unspent.</p>}
            </>
          )}
          {shown && shown.totalShares === 0 && (
            <p className="muted small">No venue can fill this order right now.</p>
          )}
        </section>

        {accountId ? (
          <button className={`cta ${side}`} disabled title="Execution is not enabled yet">
            Buy {label} · coming soon
          </button>
        ) : (
          <button className={`cta ${side}`} onClick={connect}>
            Connect wallet to trade
          </button>
        )}
        <p className="muted tiny center">
          Prices are live. Orders will settle through NEAR Intents and Chain Signatures. Execution is not enabled in
          this demo.
        </p>

        <details className="rules">
          <summary>How this market settles</summary>
          {market.listings.map((l) => (
            <div key={l.venue} className="rule">
              <div className="rule-head">
                <VenueDots venues={[l]} />
                <a href={l.url} target="_blank" rel="noreferrer">
                  {VENUE[l.venue].name} ↗
                </a>
              </div>
              <p className="small muted">{l.rulesText}</p>
            </div>
          ))}
        </details>
      </aside>
    </div>
  );
}
