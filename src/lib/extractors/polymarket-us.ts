import { isoUtc, type Asset, type ExtractResult, type PriceRef } from "@/lib/spec";

/** Subset of a Polymarket US gateway market (`GET https://gateway.polymarket.us/v1/markets`). */
export interface PolymarketUsMarket {
  slug: string;
  question: string;
  title?: string;
  subtitle?: string;
  description: string;
  endDate: string;
  active: boolean;
  closed: boolean;
  minimumTradeQty?: number;
  orderPriceMinTickSize?: number;
  feeCoefficient?: number;
  marketSides?: { description: string; long: boolean; price: string }[];
  assetPriceTerms?: {
    marketType: string;
    asset: { assetClass: string; symbol: string };
    indexSymbol: string;
    horizon: string;
    windowStart: string;
    windowEnd: string;
    priceToBeat?: { value: string; currency: string } | null;
  } | null;
}

/** "settle to Up if the Bitcoin price at 2:00AM ET … is greater than or equal to the price at 1:45AM ET" */
const UP_GE = /settle to Up if the .+? price at .+? is greater than or equal to the price at /i;
/** "Outcome sourced from CF Benchmarks' Bitcoin Real-Time Index (BRTI)" */
const SOURCE = /Outcome sourced from CF Benchmarks' .*?Real-Time Index \((\w+)\)/i;
/** "in the last minute before each of those two times, 60 BRTI prices are collected. … simple average of these prices" */
const AVG = /in the last minute before each of those two times, 60 \w+ prices are collected\. The official value for that time is the simple average of these prices/i;

const ASSETS: Record<string, Asset> = { btc: "BTC", eth: "ETH", sol: "SOL", xrp: "XRP" };

function rti(asset: Asset, at: string): PriceRef {
  // Same benchmark and window as Kalshi: simple average of the 60 RTI prints in [T - 60 s, T).
  return { asset, oracle: "cf-benchmarks-rti", aggregation: { kind: "average", seconds: 60, anchor: "trailing" }, at: isoUtc(at) };
}

/** Polymarket US crypto "Up or Down" (5m / 15m / 1h …). Up → yes. Fails closed on any unrecognised wording. */
export function extractPolymarketUsUpDown(m: PolymarketUsMarket): ExtractResult {
  const t = m.assetPriceTerms;
  if (!t || t.marketType !== "ASSET_PRICE_MARKET_TYPE_UP_DOWN") return { ok: false, error: "not an up/down asset-price market" };
  const asset = ASSETS[t.asset?.symbol?.toLowerCase() ?? ""];
  if (!asset) return { ok: false, error: `unsupported asset ${t.asset?.symbol}` };
  const d = m.description ?? "";
  const src = SOURCE.exec(d);
  if (!src || src[1] !== t.indexSymbol) return { ok: false, error: "unrecognised resolution source" };
  if (!AVG.test(d)) return { ok: false, error: "unrecognised averaging wording" };
  if (!UP_GE.test(d)) return { ok: false, error: "unrecognised comparison wording" };
  if (!t.windowStart || !t.windowEnd) return { ok: false, error: "missing window" };
  return { ok: true, spec: { kind: "price-compare", cmp: ">=", end: rti(asset, t.windowEnd), start: rti(asset, t.windowStart) } };
}
