"use client";

import { useEffect, useState } from "react";
import { VenueLogo } from "@/components/Logos";
import { fmtCents, fmtUsd, VENUE } from "@/lib/present";
import type { LiveExecution } from "@/lib/live/execute";
import type { RoutePlan } from "@/lib/router";
import type { Side, VenueId } from "@/lib/venues/types";

interface LiveStatus {
  enabled: boolean;
  maxUsd: number;
  liveVenues: VenueId[];
  venues?: Record<string, { connected: boolean; error?: string }>;
}

const newRequestId = () => `live-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Real split orders on regulated venues with the operator's own accounts (Kalshi + Polymarket US).
 * Renders nothing unless the server has ONEBOOK_LIVE_ORDERS=on.
 */
export function LiveTrade({
  markets,
  side,
  budgetUsd,
  allowNearEquivalent,
  plan,
}: {
  markets: { venue: VenueId; marketId: string }[];
  side: Side;
  budgetUsd: number;
  allowNearEquivalent: boolean;
  plan: RoutePlan | null;
}) {
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LiveExecution | null>(null);

  useEffect(() => {
    fetch("/api/live")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  if (!status?.enabled) return null;

  const legsVenues = [...new Set((plan?.allocations ?? []).map((a) => a.venue))];
  const notLive = markets.find((m) => !status.liveVenues.includes(m.venue));
  const notConnected = legsVenues.find((v) => !status.venues?.[v]?.connected);
  const tooBig = budgetUsd > status.maxUsd;
  const blocked = notLive
    ? `${VENUE[notLive.venue].name} is quote-only. Untick "also include" to trade live.`
    : notConnected
      ? `No working API key for ${VENUE[notConnected].name}${status.venues?.[notConnected]?.error ? `: ${status.venues[notConnected].error}` : ""}.`
      : tooBig
        ? `Live limit: $${status.maxUsd} per order.`
        : !plan || plan.totalShares === 0
          ? "Waiting for a route."
          : null;

  async function place() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/live/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markets, side, budgetUsd, allowNearEquivalent, requestId: newRequestId(), confirm: true }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setResult(json);
      setConfirmed(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="live-box">
      <div className="live-head">
        <strong>Live orders</strong>
        <span className="pill warn">real money</span>
      </div>
      {result ? (
        <>
          <p className="small">
            {result.outcome === "all-filled"
              ? "All legs filled."
              : result.outcome === "partial"
                ? "Partially filled: one venue filled, another did not. Nothing was retried or undone."
                : "Nothing filled. No money was spent."}
          </p>
          {result.legs.map((l) => (
            <div key={l.clientOrderId} className="route-row">
              <VenueLogo venue={l.venue} />
              <span>{VENUE[l.venue].name}</span>
              <span className={l.status === "filled" ? "win small" : l.status === "error" ? "err-text small" : "muted small"}>
                {l.status === "filled"
                  ? `filled ${l.result?.filled} @ ≤${fmtCents(l.limitPrice)}`
                  : l.status === "error"
                    ? l.error
                    : `not filled (price moved; ${l.result?.sentShares} @ ≤${fmtCents(l.limitPrice)})`}
              </span>
            </div>
          ))}
          <button className="chip-btn" onClick={() => setResult(null)}>
            New order
          </button>
        </>
      ) : (
        <>
          <p className="muted tiny">
            Sends one fill-or-kill limit order per venue from your own Kalshi and Polymarket US accounts. Each leg
            fills completely at the quoted limit or better, or not at all. Legs are independent: one can fill
            while the other does not.
          </p>
          {blocked ? (
            <p className="muted small">{blocked}</p>
          ) : (
            <label className="consent">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              Place real orders for {fmtUsd(budgetUsd)} on{" "}
              {legsVenues.map((v) => VENUE[v].name).join(" and ")}
            </label>
          )}
          <button className={`cta ${side}`} disabled={!!blocked || !confirmed || busy} onClick={place}>
            {busy ? "Placing…" : `Place live orders · ${fmtUsd(budgetUsd)}`}
          </button>
          {error && <p className="err-text small">{error}</p>}
        </>
      )}
    </section>
  );
}
