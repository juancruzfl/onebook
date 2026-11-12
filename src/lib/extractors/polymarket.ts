import { isoUtc, type Asset, type ExtractResult, type PriceRef } from "@/lib/spec";

/** Subset of a Gamma API market object that the extractor reads. */
export interface GammaMarket {
  conditionId: string;
  question: string;
  slug?: string;
  description: string;
  resolutionSource?: string;
  outcomes: string; // JSON string, e.g. '["Up", "Down"]'
  clobTokenIds: string; // JSON string, same order as outcomes
  eventStartTime?: string;
  endDate: string;
  orderMinSize?: number;
  /** Best ask / bid of the FIRST outcome's token (e.g. "Up"). */
  bestAsk?: number;
  bestBid?: number;
  outcomePrices?: string;
  acceptingOrders?: boolean;
}


/**
 * Polymarket "<Asset> Up or Down" 15-minute markets.
 *
 * Two rule templates have been observed:
 *  - 2026 (current): Chainlink TWAP 60s stream; "TWAP ... of the time range ... is greater than or
 *    equal to the price at the beginning of that range". Which 60s window the TWAP covers is NOT stated,
 *    so aggregation anchor is "unspecified" (the matcher surfaces this as a warning).
 *  - 2025 (legacy): Chainlink point data stream; "price at the end ... greater than or equal to the price
 *    at the beginning".
 * Anything else is rejected: an unrecognised rule must never be routed.
 */
export function extractPolymarketUpDown(m: GammaMarket, asset: Asset): ExtractResult {
  const d = m.description ?? "";
  const start = m.eventStartTime;
  if (!start) return { ok: false, error: "missing eventStartTime" };
  if (!/greater than or equal to the price at the beginning of that range/i.test(d))
    return { ok: false, error: "unrecognised comparison wording" };

  let base: Omit<PriceRef, "at">;
  if (/Chainlink/i.test(d) && /TWAP/i.test(d) && /twap-60s/i.test(d + (m.resolutionSource ?? ""))) {
    base = { asset, oracle: "chainlink-twap-60s", aggregation: { kind: "average", seconds: 60, anchor: "unspecified" } };
  } else if (/Chainlink/i.test(d) && /data stream/i.test(d) && !/TWAP/i.test(d)) {
    base = { asset, oracle: "chainlink-data-stream", aggregation: { kind: "point" } };
  } else {
    return { ok: false, error: "unrecognised resolution source" };
  }

  return {
    ok: true,
    spec: {
      kind: "price-compare",
      cmp: ">=",
      end: { ...base, at: isoUtc(m.endDate) },
      start: { ...base, at: isoUtc(start) },
    },
  };
}

/** Map Polymarket outcome labels to onebook yes/no legs ("Up" pays when the spec is true). */
export function polymarketLegs(m: GammaMarket): { yes: string; no: string } | null {
  const outcomes = JSON.parse(m.outcomes) as string[];
  const tokens = JSON.parse(m.clobTokenIds) as string[];
  const up = outcomes.findIndex((o) => /^up$/i.test(o));
  const down = outcomes.findIndex((o) => /^down$/i.test(o));
  if (up < 0 || down < 0 || !tokens[up] || !tokens[down]) return null;
  return { yes: tokens[up], no: tokens[down] };
}
