import { isoUtc, type Asset, type Comparator, type ExtractResult, type PriceRef } from "@/lib/spec";

/** Subset of a Kalshi trade-api v2 market object. */
export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  title: string;
  yes_sub_title?: string;
  open_time: string;
  close_time: string;
  floor_strike?: number;
  strike_type?: string;
  rules_primary: string;
  rules_secondary?: string;
  yes_ask_dollars?: string;
  no_ask_dollars?: string;
  status?: string;
}

const SIXTY_SEC_BRTI = /simple average of the sixty seconds of CF Benchmarks'.*?(RTI|Real[- ]Time Index)/i;

function brti(asset: Asset, at: string): PriceRef {
  return {
    asset,
    oracle: "cf-benchmarks-rti",
    // "the simple average of the sixty seconds of ... BRTI before <time>" => window ends at `at`.
    aggregation: { kind: "average", seconds: 60, anchor: "trailing" },
    at: isoUtc(at),
  };
}

/** Kalshi KX<ASSET>15M: "<asset> price up in next 15 mins?" */
export function extractKalshiUpDown(m: KalshiMarket, asset: Asset): ExtractResult {
  const r = m.rules_primary ?? "";
  if (!SIXTY_SEC_BRTI.test(r)) return { ok: false, error: "unrecognised resolution source" };
  if (!/is at least the simple average of the sixty seconds/i.test(r))
    return { ok: false, error: "unrecognised comparison wording" };
  return {
    ok: true,
    spec: { kind: "price-compare", cmp: ">=", end: brti(asset, m.close_time), start: brti(asset, m.open_time) },
  };
}

/** Kalshi KX<ASSET>D: "<asset> price on <date>?" strike ladders ("$83,250 or above"). */
export function extractKalshiThreshold(m: KalshiMarket, asset: Asset): ExtractResult {
  const r = m.rules_primary ?? "";
  if (!SIXTY_SEC_BRTI.test(r)) return { ok: false, error: "unrecognised resolution source" };
  const cmp: Comparator | null =
    m.strike_type === "greater" ? ">" : m.strike_type === "greater_or_equal" ? ">=" : null;
  if (!cmp || typeof m.floor_strike !== "number")
    return { ok: false, error: `unsupported strike_type ${m.strike_type ?? "none"}` };
  return { ok: true, spec: { kind: "price-threshold", cmp, strike: m.floor_strike, ref: brti(asset, m.close_time) } };
}
