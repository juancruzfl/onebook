import { NextResponse } from "next/server";
import { QuoteError } from "@/lib/quote";

/** Map engine errors to HTTP responses. */
export function errorResponse(e: unknown) {
  if (e instanceof QuoteError) return NextResponse.json({ error: e.message, ...e.detail }, { status: e.status });
  console.error("[orders]", e);
  return NextResponse.json({ error: (e as Error).message ?? "internal error" }, { status: 502 });
}
