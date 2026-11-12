"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Logo } from "@/components/Logo";
import { VenueLogo } from "@/components/Logos";
import { MarketCard } from "@/components/MarketCard";
import { TradePanel } from "@/components/TradePanel";
import { WalletButton } from "@/components/WalletButton";
import { toMarketView, type GroupDto, type MarketView } from "@/lib/market-view";
import { marketCopy, VENUE } from "@/lib/present";
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
  const [query, setQuery] = useState("");
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
      // Hide markets in their final minute: books empty out and quotes go stale.
      .filter((m) => new Date(m.closeTime).getTime() - Date.now() > 60_000)
      .filter((m) => showAll || m.tier !== "related")
      .filter((m) => tab === "all" || m.asset === tab)
      .filter((m) => {
        const q = query.trim().toLowerCase();
        if (!q) return true;
        const c = marketCopy(m.spec);
        return `${c.title} ${c.subtitle} ${m.asset} ${m.listings.map((l) => l.venue).join(" ")}`.toLowerCase().includes(q);
      })
      .sort((a, b) => a.closeTime.localeCompare(b.closeTime) || a.asset.localeCompare(b.asset));
  }, [data, tab, showAll, query]);

  const active = trade ? markets.find((m) => m.key === trade.key) : undefined;

  return (
    <div className="app">
      <nav className="nav">
        <div className="nav-inner">
          <Logo />
          <label className="search">
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
              <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
              <path d="M20 20l-4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <input
              type="search"
              placeholder="Search markets"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search markets"
            />
          </label>
          <WalletButton />
        </div>
        <div className="nav-inner nav-tabs">
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
      </nav>

      <main className="wrap">
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
            <p>{query ? `No markets match "${query}".` : "No matching markets right now."}</p>
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
                <VenueLogo venue={s.venue} size={16} />
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
