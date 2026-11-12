"use client";

import { useCallback, useEffect, useState } from "react";
import { ConnectAccounts } from "@/components/ConnectAccounts";
import { VenueLogo } from "@/components/Logos";
import { loadConnections, type VenueConnection } from "@/lib/live/browser-keys";
import { planLiveOrder, sendLeg } from "@/lib/live/client";
import type { LiveExecution } from "@/lib/live/execute";
import { isLiveVenue, type LiveVenue } from "@/lib/live/orders";
import { fmtCents, fmtUsd, VENUE } from "@/lib/present";
import type { Side, VenueId } from "@/lib/venues/types";

interface LiveStatus {
  enabled: boolean;
  maxUsd: number;
}

const newRequestId = () => `live-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Real split orders on regulated venues from the user's OWN accounts (Kalshi, Polymarket US), signed in
 * the browser with keys that never leave it. Renders nothing unless the server has ONEBOOK_LIVE_ORDERS=on.
 */
export function LiveTrade({ markets, side, budgetUsd }: { markets: { venue: VenueId; marketId: string }[]; side: Side; budgetUsd: number }) {
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [conns, setConns] = useState<Partial<Record<LiveVenue, VenueConnection>>>({});
  const [showAccounts, setShowAccounts] = useState(false);
  const [review, setReview] = useState<LiveExecution | null>(null);
  const [result, setResult] = useState<LiveExecution | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshConns = useCallback(() => void loadConnections().then(setConns), []);
  useEffect(() => {
    fetch("/api/live")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus(null));
    refreshConns();
  }, [refreshConns]);

  // A new amount/side/market invalidates a reviewed plan.
  useEffect(() => {
    setReview(null);
    setConfirmed(false);
  }, [markets, side, budgetUsd]);

  if (!status?.enabled) return null;

  // Only regulated venues are ever traded live; the caller passes just those.
  const live = markets.filter((m) => isLiveVenue(m.venue));
  const tradable = live.filter((m) => conns[m.venue as LiveVenue]);
  const connectedNames = tradable.map((m) => VENUE[m.venue].name);
  const blocked =
    live.length === 0
      ? "This market isn't listed on Kalshi or Polymarket US right now."
      : tradable.length === 0
        ? `Connect your ${live.map((m) => VENUE[m.venue].name).join(" or ")} account to trade live.`
      : budgetUsd > status.maxUsd
        ? `Live limit: ${fmtUsd(status.maxUsd)} per order.`
        : !(budgetUsd > 0)
          ? "Enter an amount."
          : null;

  async function doReview() {
    setBusy(true);
    setError(null);
    try {
      setReview(await planLiveOrder({ markets: tradable, side, budgetUsd, requestId: newRequestId() }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function place() {
    if (!review) return;
    setBusy(true);
    setError(null);
    try {
      const results = await Promise.allSettled(review.legs.map((l, i) => sendLeg(review, i, conns[l.venue]!)));
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed) setError(String(failed.reason?.message ?? failed.reason));
      const res = await fetch(`/api/live/${review.id}`);
      setResult(res.ok ? ((await res.json()) as LiveExecution) : null);
      setReview(null);
      setConfirmed(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="live-box">
      <div className="live-head">
        <strong>Trade live with your accounts</strong>
        <button className="link-btn" onClick={() => setShowAccounts((s) => !s)}>
          {showAccounts ? "Hide accounts" : `Accounts (${Object.keys(conns).length})`}
        </button>
      </div>
      {(showAccounts || Object.keys(conns).length === 0) && <ConnectAccounts connections={conns} onChange={refreshConns} />}

      {result ? (
        <>
          <p className="small">
            {result.outcome === "all-filled"
              ? "All legs filled."
              : result.outcome === "partial"
                ? "Partially filled: one venue filled, another did not. Nothing was retried or undone."
                : result.outcome === "none-filled"
                  ? "Nothing filled. No money was spent."
                  : "Some legs are still pending."}
          </p>
          {result.legs.map((l) => (
            <div key={l.clientOrderId} className="route-row">
              <VenueLogo venue={l.venue} />
              <span>{VENUE[l.venue].name}</span>
              <span className={l.status === "filled" ? "win small" : l.status === "error" ? "err-text small" : "muted small"}>
                {l.status === "filled"
                  ? `filled ${l.filled} @ ≤${fmtCents(l.limitPrice)}`
                  : l.status === "error"
                    ? l.error
                    : l.status === "not-filled"
                      ? `not filled (price moved)`
                      : l.status}
              </span>
            </div>
          ))}
          <button className="chip-btn" onClick={() => setResult(null)}>
            New order
          </button>
        </>
      ) : review ? (
        <>
          <p className="muted tiny">
            Exact orders to send, each fill-or-kill: it fills completely at the limit or better, or not at all.
            Legs are independent. This review expires in 30 seconds.
          </p>
          {review.legs.map((l) => (
            <div key={l.clientOrderId} className="route-row">
              <VenueLogo venue={l.venue} />
              <span>{VENUE[l.venue].name}</span>
              <span className="muted small">
                {l.shares} {side === "yes" ? "Yes" : "No"} @ ≤{fmtCents(l.limitPrice)} · ~{fmtUsd(l.plannedCost)}
              </span>
            </div>
          ))}
          <label className="consent">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            Place these real orders from my accounts
          </label>
          <button className={`cta ${side}`} disabled={!confirmed || busy} onClick={place}>
            {busy ? "Placing…" : `Place live orders · ${fmtUsd(budgetUsd)}`}
          </button>
          <button className="link-btn" onClick={() => setReview(null)}>
            Cancel
          </button>
        </>
      ) : (
        <>
          {blocked ? (
            <p className="muted small">{blocked}</p>
          ) : (
            <p className="muted tiny">Routes {fmtUsd(budgetUsd)} across {connectedNames.join(" and ")}. You review the exact orders next.</p>
          )}
          <button className={`cta ${side}`} disabled={!!blocked || busy} onClick={doReview}>
            {busy ? "Preparing…" : "Review live order"}
          </button>
        </>
      )}
      {error && <p className="err-text small">{error}</p>}
    </section>
  );
}
