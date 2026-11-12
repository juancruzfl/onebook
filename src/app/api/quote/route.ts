import { NextResponse } from "next/server";
import { computeQuote, QuoteError, validateQuoteInput, type QuoteInput } from "@/lib/quote";

export const dynamic = "force-dynamic";

/**
 * POST /api/quote
 * Re-validates that the requested markets are fungible, fetches live order books and
 * returns the cheapest split. Read-only: nothing is signed or submitted.
 */
export async function POST(req: Request) {
  let body: Partial<QuoteInput>;
  try {
    body = (await req.json()) as Partial<QuoteInput>;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  try {
    const { plan } = await computeQuote(validateQuoteInput(body));
    return NextResponse.json({ quotedAt: new Date().toISOString(), plan, dryRun: true });
  } catch (e) {
    if (e instanceof QuoteError) return NextResponse.json({ error: e.message, ...e.detail }, { status: e.status });
    return NextResponse.json({ error: `order book fetch failed: ${(e as Error).message}` }, { status: 502 });
  }
}
