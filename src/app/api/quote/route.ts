import { NextResponse } from "next/server";
import { compareSpecs } from "@/lib/matcher";
import { planRoute } from "@/lib/router";
import { listAllMarkets, VENUES } from "@/lib/venues";
import type { Side, VenueId } from "@/lib/venues/types";

export const dynamic = "force-dynamic";

interface QuoteRequest {
  markets: { venue: VenueId; marketId: string }[];
  side: Side;
  budgetUsd: number;
  /** Must be true to route across near-equivalent markets (e.g. different oracles). */
  allowNearEquivalent?: boolean;
}

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

/**
 * POST /api/quote
 * Re-validates that the requested markets are fungible, fetches live order books and
 * returns the cheapest split. Read-only: nothing is signed or submitted.
 */
export async function POST(req: Request) {
  let body: QuoteRequest;
  try {
    body = (await req.json()) as QuoteRequest;
  } catch {
    return bad("invalid JSON");
  }
  const { markets, side, budgetUsd, allowNearEquivalent = false } = body;
  if (!Array.isArray(markets) || markets.length < 1 || markets.length > 5) return bad("markets: 1-5 entries");
  if (side !== "yes" && side !== "no") return bad("side: yes|no");
  if (!(typeof budgetUsd === "number" && budgetUsd > 0 && budgetUsd <= 100_000)) return bad("budgetUsd: 0-100000");

  // Never trust the client's grouping: re-fetch and re-check every pair server-side.
  const { listings } = await listAllMarkets();
  const chosen = markets.map((m) => listings.find((l) => l.venue === m.venue && l.marketId === m.marketId));
  if (chosen.some((l) => !l)) return bad("unknown or closed market", 404);
  if (chosen.some((l) => !l!.spec)) return bad("market has no recognised payout spec; refusing to route");

  for (let i = 0; i < chosen.length; i++)
    for (let j = i + 1; j < chosen.length; j++) {
      const c = compareSpecs(chosen[i]!.spec!, chosen[j]!.spec!);
      if (c.tier === "related") return NextResponse.json({ error: "markets do not pay out the same", ...c }, { status: 422 });
      if (c.tier === "near-equivalent" && !allowNearEquivalent)
        return NextResponse.json({ error: "near-equivalent markets require allowNearEquivalent: true", ...c }, { status: 422 });
    }

  try {
    const books = await Promise.all(
      chosen.map(async (l) => ({
        listing: l!,
        asks: await VENUES[l!.venue].getAsks(l!, side),
        takerFee: VENUES[l!.venue].takerFee,
      })),
    );
    const plan = planRoute(books, side, budgetUsd);
    return NextResponse.json({ quotedAt: new Date().toISOString(), plan, dryRun: true });
  } catch (e) {
    return bad(`order book fetch failed: ${(e as Error).message}`, 502);
  }
}
