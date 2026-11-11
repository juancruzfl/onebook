import type { ExtractResult } from "@/lib/spec";

/** One entry of `outcomes` from POST /info {"type":"outcomeMeta"}. */
export interface HlOutcome {
  outcome: number;
  name: string;
  /** Pipe-separated key:value pairs, e.g. "class:priceBinary|underlying:BTC|expiry:20260504-0600|targetPrice:78213|period:1d" */
  description: string;
}

export function parseHlDescription(desc: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of desc.split("|")) {
    const i = part.indexOf(":");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** "20260504-0600" -> "2026-05-04T06:00:00.000Z" (UTC). */
export function parseHlExpiry(s: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(s);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])).toISOString() : null;
}

/**
 * Hyperliquid HIP-4 `priceBinary` outcomes. YES iff the HyperCore mark price (linearly interpolated
 * between the two mark updates around expiry) is >= targetPrice.
 */
export function extractHyperliquidPriceBinary(o: HlOutcome): ExtractResult {
  const f = parseHlDescription(o.description);
  if (f.class !== "priceBinary") return { ok: false, error: `unsupported class ${f.class ?? "none"}` };
  const at = f.expiry ? parseHlExpiry(f.expiry) : null;
  const strike = Number(f.targetPrice);
  if (!f.underlying || !at || !Number.isFinite(strike)) return { ok: false, error: "malformed description" };
  return {
    ok: true,
    spec: {
      kind: "price-threshold",
      cmp: ">=",
      strike,
      ref: { asset: f.underlying, oracle: "hyperliquid-mark", aggregation: { kind: "point" }, at },
    },
  };
}

/**
 * Order-book coin for an outcome side. Per third-party docs (Chainstack), outcome sides trade as
 * "#<encoding>" with encoding = 10 * outcome + side (side 0 = YES, 1 = NO).
 * TODO(verify): confirm against official Hyperliquid docs before enabling execution.
 */
export const hlCoin = (outcome: number, side: 0 | 1) => `#${outcome * 10 + side}`;
