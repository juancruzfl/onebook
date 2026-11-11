/**
 * PayoutSpec: a venue-independent description of HOW a market pays out.
 *
 * onebook matches markets on payout, not on event title. Two markets are only
 * routed together when their specs say they pay out under the same conditions.
 *
 * Convention: every spec describes the condition under which the "yes" leg pays $1.
 * Venue-specific outcome labels ("Up", "Yes", side 0, ...) are mapped onto
 * yes/no by the extractor that produced the spec.
 */

export type Asset = "BTC" | "ETH" | "SOL" | (string & {});

/** Where a price comes from. Add new oracles here as venues are added. */
export type Oracle =
  | "chainlink-data-stream" // Chainlink Data Streams, point value
  | "chainlink-twap-60s" // Chainlink BTC/USD TWAP 60s stream (Polymarket 15m markets since 2026)
  | "cf-benchmarks-rti" // CF Benchmarks Real Time Index (Kalshi crypto markets)
  | "hyperliquid-mark" // HyperCore mark price (Hyperliquid HIP-4)
  | "binance-candle" // Binance 1m/1h candle close (some Polymarket markets)
  | (string & {});

export type Aggregation =
  | { kind: "point" }
  /**
   * Average over `seconds`. `anchor` says where the window sits relative to `at`:
   * - "trailing": the window ends at `at` (e.g. Kalshi "sixty seconds before 6:15 PM")
   * - "unspecified": the venue's rules do not say; treated as a warning when compared.
   */
  | { kind: "average"; seconds: number; anchor: "trailing" | "unspecified" };

export interface PriceRef {
  asset: Asset;
  oracle: Oracle;
  aggregation: Aggregation;
  /** ISO-8601 UTC timestamp, e.g. "2026-11-11T23:15:00.000Z". */
  at: string;
}

export type Comparator = ">=" | ">";

export type PayoutSpec =
  /** YES iff price(end) <cmp> price(start). "Up or Down" markets. */
  | { kind: "price-compare"; end: PriceRef; cmp: Comparator; start: PriceRef }
  /** YES iff price(at) <cmp> strike. "BTC above $X at time T" markets. */
  | { kind: "price-threshold"; ref: PriceRef; cmp: Comparator; strike: number }
  /** Free-form events. Hand-written (or LLM-extracted + human-reviewed) specs. */
  | {
      kind: "event";
      proposition: string;
      source: string;
      /** ISO-8601 UTC cutoff. */
      cutoff: string;
      /** e.g. { postponed: "void", tie: "no" } */
      edgeCases: Record<string, string>;
    };

/** Normalize any date input to a canonical ISO string so specs compare by string equality. */
export function isoUtc(input: string | number | Date): string {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date: ${String(input)}`);
  return d.toISOString();
}

/** Output of every extractor. A failed extraction means "do not route this market". */
export type ExtractResult = { ok: true; spec: PayoutSpec } | { ok: false; error: string };
