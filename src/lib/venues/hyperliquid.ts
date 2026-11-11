import { getJson, r4 } from "@/lib/http";
import { extractHyperliquidPriceBinary, hlCoin, type HlOutcome } from "@/lib/extractors/hyperliquid";
import type { Level, Listing, Side, VenueAdapter } from "@/lib/venues/types";

const INFO = "https://api.hyperliquid.xyz/info";

const post = <T>(body: unknown) => getJson<T>(INFO, { method: "POST", body: JSON.stringify(body) });

async function listMarkets(): Promise<Listing[]> {
  const meta = await post<{ outcomes: HlOutcome[] }>({ type: "outcomeMeta" });
  const listings: Listing[] = [];
  for (const o of meta.outcomes ?? []) {
    const ex = extractHyperliquidPriceBinary(o);
    if (!ex.ok && ex.error.startsWith("unsupported class")) continue; // only list types we understand
    const close = ex.ok && ex.spec.kind === "price-threshold" ? ex.spec.ref.at : null;
    if (!close || new Date(close).getTime() <= Date.now()) continue;
    listings.push({
      venue: "hyperliquid",
      marketId: String(o.outcome),
      title: o.name,
      url: "https://app.hyperliquid.xyz/",
      spec: ex.ok ? ex.spec : null,
      extractError: ex.ok ? undefined : ex.error,
      legs: { yes: hlCoin(o.outcome, 0), no: hlCoin(o.outcome, 1) },
      minOrder: { notionalUsd: 10 },
      closeTime: close,
      rulesText: o.description,
    });
  }
  return listings;
}

interface L2Book {
  levels: [{ px: string; sz: string }[], { px: string; sz: string }[]]; // [bids, asks]
}

export const hyperliquid: VenueAdapter = {
  id: "hyperliquid",
  displayName: "Hyperliquid (HIP-4)",
  collateral: { chain: "hypercore", asset: "USDH" }, // TODO(verify): sources disagree USDH vs USDC
  listMarkets,
  async getAsks(listing: Listing, side: Side): Promise<Level[]> {
    const book = await post<L2Book>({ type: "l2Book", coin: listing.legs[side] });
    return (book.levels?.[1] ?? [])
      .map((l) => ({ price: r4(Number(l.px)), size: Number(l.sz) }))
      .sort((x, y) => x.price - y.price);
  },
  takerFee: () => 0, // HIP-4 outcome fees were zero at launch. TODO(verify).
};
