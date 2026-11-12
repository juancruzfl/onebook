"use client";

import { Countdown } from "@/components/Countdown";
import { AssetIcon, VenueLogo } from "@/components/Logos";
import { chance, type MarketView } from "@/lib/market-view";
import { fmtCents, marketCopy, TIER_COPY } from "@/lib/present";
import type { Side } from "@/lib/venues/types";

export { AssetIcon };

export function VenueDots({ venues }: { venues: MarketView["listings"] }) {
  return (
    <span className="venue-dots">
      {venues.map((l) => (
        <VenueLogo key={l.venue} venue={l.venue} />
      ))}
    </span>
  );
}

function ChanceGauge({ value }: { value: number | null }) {
  const v = value ?? 0;
  const r = 22;
  const c = Math.PI * r; // half circle
  return (
    <div className="gauge" aria-label={value === null ? "no price" : `${v}% chance`}>
      <svg viewBox="0 0 56 32" width="64" height="36">
        <path d={`M6 30 A${r} ${r} 0 0 1 50 30`} className="gauge-track" />
        <path
          d={`M6 30 A${r} ${r} 0 0 1 50 30`}
          className="gauge-fill"
          style={{ strokeDasharray: `${(v / 100) * c} ${c}`, stroke: v >= 50 ? "var(--yes)" : "var(--no)" }}
        />
      </svg>
      <span className="gauge-value">{value === null ? "–" : `${v}%`}</span>
      <span className="gauge-label">chance</span>
    </div>
  );
}

export function MarketCard({ market, onTrade }: { market: MarketView; onTrade: (m: MarketView, side: Side) => void }) {
  const copy = marketCopy(market.spec);
  const tier = TIER_COPY[market.tier];
  const routable = market.tier !== "related";
  return (
    <article className="mcard">
      <header className="mcard-head">
        <AssetIcon asset={market.asset} />
        <div className="mcard-title">
          <h3>{copy.title}</h3>
          <span className="muted small">{copy.subtitle}</span>
        </div>
        <ChanceGauge value={chance(market)} />
      </header>

      <div className="mcard-actions">
        <button className="outcome yes" disabled={!routable || !market.best.yes} onClick={() => onTrade(market, "yes")}>
          <span>{copy.yes}</span>
          <span className="outcome-price">{fmtCents(market.best.yes?.price)}</span>
        </button>
        <button className="outcome no" disabled={!routable || !market.best.no} onClick={() => onTrade(market, "no")}>
          <span>{copy.no}</span>
          <span className="outcome-price">{fmtCents(market.best.no?.price)}</span>
        </button>
      </div>

      <footer className="mcard-foot">
        <Countdown to={market.closeTime} />
        <span className="dot-sep" />
        <VenueDots venues={market.listings} />
        <span className={`pill ${tier.tone}`} title={tier.explain}>
          {tier.label}
        </span>
      </footer>
    </article>
  );
}
