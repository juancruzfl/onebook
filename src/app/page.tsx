"use client";

import { useCallback, useEffect, useState } from "react";
import type { Diff, Tier } from "@/lib/matcher";
import type { RoutePlan } from "@/lib/router";
import type { Listing, Side } from "@/lib/venues/types";
import type { VenueStatus } from "@/lib/venues";
import { WalletButton } from "@/components/WalletButton";

interface Pair {
  a: Listing;
  b: Listing;
  tier: Tier;
  diffs: Diff[];
}
interface Group {
  key: string;
  listings: Listing[];
  pairs: Pair[];
  bestTier: Tier;
}
interface MarketsResponse {
  fetchedAt: string;
  status: VenueStatus[];
  groups: Group[];
  unextracted: { venue: string; marketId: string; title: string; error?: string }[];
}

const TIER_LABEL: Record<Tier, string> = {
  equivalent: "Equivalent",
  "near-equivalent": "Near-equivalent",
  related: "Related · not routable",
};

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
const pct = (n?: number) => (n === undefined || Number.isNaN(n) ? "–" : `${(n * 100).toFixed(1)}¢`);

/** Bucket keys look like "price:BTC:2026-11-11T23:15:00.000Z" (the ISO time contains colons). */
function groupTitle(key: string) {
  const parts = key.split(":");
  return { asset: parts[1], at: parts.slice(2).join(":") };
}

export default function Home() {
  const [data, setData] = useState<MarketsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showRelated, setShowRelated] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/markets", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const groups = (data?.groups ?? []).filter((g) => showRelated || g.bestTier !== "related");

  return (
    <main className="wrap">
      <header className="top">
        <div>
          <h1>onebook</h1>
          <p className="muted">
            One order book across prediction markets. Markets are matched on <strong>how they pay out</strong>, not on
            their title.
          </p>
        </div>
        <div className="row">
          <button onClick={load} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </button>
          <WalletButton />
        </div>
      </header>

      {data && (
        <section className="status">
          {data.status.map((s) => (
            <span key={s.venue} className={`chip ${s.ok ? "ok" : "err"}`} title={s.error}>
              {s.venue}: {s.ok ? `${s.count} markets` : "unavailable"}
            </span>
          ))}
          <label className="toggle">
            <input type="checkbox" checked={showRelated} onChange={(e) => setShowRelated(e.target.checked)} /> show
            related (non-routable) groups
          </label>
        </section>
      )}

      {error && <p className="err-text">Failed to load markets: {error}</p>}
      {data && groups.length === 0 && <p className="muted">No cross-venue matches right now. Try refreshing.</p>}

      {groups.map((g) => (
        <GroupCard key={g.key} group={g} />
      ))}

      <footer className="muted small">
        Read-only proof of concept. Quotes use live order books; nothing is signed or submitted. Not available where
        venues restrict access.
      </footer>
    </main>
  );
}

function GroupCard({ group }: { group: Group }) {
  const { asset, at } = groupTitle(group.key);
  const pairs = group.pairs.filter((p) => p.tier !== "related").concat(group.pairs.filter((p) => p.tier === "related").slice(0, 3));
  return (
    <section className="card">
      <div className="card-head">
        <h2>
          {asset} · settles {fmtTime(at)}
        </h2>
        <span className={`tier ${group.bestTier}`}>{TIER_LABEL[group.bestTier]}</span>
      </div>
      {pairs.map((p) => (
        <PairRow key={`${p.a.marketId}|${p.b.marketId}`} pair={p} />
      ))}
      {group.pairs.length > pairs.length && (
        <p className="muted small">+{group.pairs.length - pairs.length} more related pairs hidden</p>
      )}
    </section>
  );
}

function PairRow({ pair }: { pair: Pair }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pair">
      <div className="legs">
        {[pair.a, pair.b].map((l) => (
          <a key={l.venue + l.marketId} className="leg" href={l.url} target="_blank" rel="noreferrer">
            <span className="venue">{l.venue}</span>
            <span className="title">{l.title}</span>
            <span className="px">
              yes {pct(l.preview?.yes)} · no {pct(l.preview?.no)}
            </span>
          </a>
        ))}
      </div>
      <div className="diffs">
        <span className={`tier ${pair.tier}`}>{TIER_LABEL[pair.tier]}</span>
        {pair.diffs.length === 0 && <span className="muted small">identical payout specs</span>}
        {pair.diffs.map((d) => (
          <span key={d.field} className={`diff ${d.severity}`} title={`${d.a}  vs  ${d.b}`}>
            {d.field}: {d.a} ≠ {d.b}
          </span>
        ))}
      </div>
      {pair.tier !== "related" && (
        <>
          <button className="link" onClick={() => setOpen((o) => !o)}>
            {open ? "Hide quote" : "Quote a route"}
          </button>
          {open && <QuoteForm pair={pair} />}
        </>
      )}
    </div>
  );
}

function QuoteForm({ pair }: { pair: Pair }) {
  const [side, setSide] = useState<Side>("yes");
  const [budget, setBudget] = useState(50);
  const [allowNear, setAllowNear] = useState(false);
  const [plan, setPlan] = useState<RoutePlan | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const near = pair.tier === "near-equivalent";

  async function quote() {
    setBusy(true);
    setErr(null);
    setPlan(null);
    try {
      const res = await fetch("/api/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          markets: [pair.a, pair.b].map((l) => ({ venue: l.venue, marketId: l.marketId })),
          side,
          budgetUsd: budget,
          allowNearEquivalent: allowNear,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setPlan(json.plan);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="quote">
      <div className="row">
        <label>
          Side{" "}
          <select value={side} onChange={(e) => setSide(e.target.value as Side)}>
            <option value="yes">YES / Up</option>
            <option value="no">NO / Down</option>
          </select>
        </label>
        <label>
          Budget ${" "}
          <input type="number" min={1} step={1} value={budget} onChange={(e) => setBudget(Number(e.target.value))} />
        </label>
        {near && (
          <label className="warn-label">
            <input type="checkbox" checked={allowNear} onChange={(e) => setAllowNear(e.target.checked)} /> I accept the
            differences above (these markets could resolve differently)
          </label>
        )}
        <button onClick={quote} disabled={busy || (near && !allowNear)}>
          {busy ? "Quoting…" : "Get route"}
        </button>
      </div>
      {err && <p className="err-text">{err}</p>}
      {plan && <PlanView plan={plan} />}
    </div>
  );
}

function PlanView({ plan }: { plan: RoutePlan }) {
  return (
    <div className="plan">
      <table>
        <thead>
          <tr>
            <th>Venue</th>
            <th>Shares</th>
            <th>Cost</th>
            <th>Avg</th>
            <th>Limit</th>
          </tr>
        </thead>
        <tbody>
          {plan.allocations.map((a) => (
            <tr key={a.venue + a.marketId}>
              <td>{a.venue}</td>
              <td>{a.shares.toFixed(2)}</td>
              <td>${a.cost.toFixed(2)}</td>
              <td>{pct(a.avgPrice)}</td>
              <td>{pct(a.limitPrice)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        Total <strong>{plan.totalShares.toFixed(2)} shares</strong> for ${plan.totalCost.toFixed(2)} (avg{" "}
        {pct(plan.avgPrice)}). Pays ${plan.totalShares.toFixed(2)} if {plan.side.toUpperCase()} wins.
      </p>
      {plan.bestSingleVenue && (
        <p className="muted">
          Best single venue: {plan.bestSingleVenue.venue}, {plan.bestSingleVenue.shares.toFixed(2)} shares. Routing adds{" "}
          <strong>${plan.improvementUsd.toFixed(2)}</strong> of payout.
        </p>
      )}
      <p className="muted small">Dry run: no order was signed or sent.</p>
    </div>
  );
}
