"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { MarketCard } from "@/components/MarketCard";
import { TradePanel } from "@/components/TradePanel";
import { WalletButton } from "@/components/WalletButton";
import { toMarketView, type GroupDto, type MarketView } from "@/lib/market-view";
import { VENUE } from "@/lib/present";
import type { Side } from "@/lib/venues/types";
import type { VenueStatus } from "@/lib/venues";

interface MarketsResponse {
  fetchedAt: string;
  status: VenueStatus[];
  groups: GroupDto[];
}

const TABS = [
  { id: "all", label: "All" },
  { id: "BTC", label: "Bitcoin" },
  { id: "ETH", label: "Ethereum" },
  { id: "SOL", label: "Solana" },
] as const;

const REFRESH_MS = 20_000;

export default function Home() {
  const [data, setData] = useState<MarketsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("all");
  const [showAll, setShowAll] = useState(false);
  const [trade, setTrade] = useState<{ key: string; side: Side } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/markets", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const markets = useMemo(() => {
    const views = (data?.groups ?? []).map(toMarketView).filter((m): m is MarketView => m !== null);
    return views
      .filter((m) => new Date(m.closeTime).getTime() > Date.now())
      .filter((m) => showAll || m.tier !== "related")
      .filter((m) => tab === "all" || m.asset === tab)
      .sort((a, b) => a.closeTime.localeCompare(b.closeTime) || a.asset.localeCompare(b.asset));
  }, [data, tab, showAll]);

  const active = trade ? markets.find((m) => m.key === trade.key) : undefined;

  return (
    <div className="app">
      <nav className="nav">
        <div className="nav-inner">
          <span className="brand">
            <svg className="brand-mark" width="24" height="24" viewBox="0 0 24 24" aria-hidden>
              <circle cx="9" cy="12" r="7" fill="var(--accent)" opacity="0.55" />
              <circle cx="15" cy="12" r="7" fill="var(--accent)" />
            </svg>
            onebook
          </span>
          <WalletButton />
        </div>
      </nav>

      <main className="wrap">
        <section className="hero">
          <h1>One order. Every prediction market.</h1>
          <p className="muted">
            onebook finds the same bet on Polymarket, Kalshi and Hyperliquid and fills your order at the best combined
            price. It only combines markets that pay out the same way.
          </p>
        </section>

        <div className="toolbar">
          <div className="tabs" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                className={`tab ${tab === t.id ? "active" : ""}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <label className="switch">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
            <span>Show non-combinable</span>
          </label>
        </div>

        {error && <p className="err-text">Couldn&apos;t load markets ({error}). Retrying…</p>}

        {!data && !error && (
          <div className="grid">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="mcard skeleton" />
            ))}
          </div>
        )}

        {data && markets.length === 0 && (
          <div className="empty">
            <p>No matching markets right now.</p>
            <p className="muted small">New 15-minute markets open every quarter hour. This page refreshes on its own.</p>
          </div>
        )}

        <div className="grid">
          {markets.map((m) => (
            <MarketCard key={m.key} market={m} onTrade={(mk, side) => setTrade({ key: mk.key, side })} />
          ))}
        </div>

        {data && (
          <footer className="status-bar">
            {data.status.map((s) => (
              <span key={s.venue} className={`status ${s.ok ? "ok" : "down"}`} title={s.error}>
                <span className="status-dot" />
                {VENUE[s.venue].name}
              </span>
            ))}
            <span className="muted tiny">Updated {new Date(data.fetchedAt).toLocaleTimeString()}</span>
          </footer>
        )}
      </main>

      {active && trade && (
        <TradePanel
          market={active}
          side={trade.side}
          onSide={(side) => setTrade({ key: active.key, side })}
          onClose={() => setTrade(null)}
        />
      )}
    </div>
  );
}
