import type { PayoutSpec } from "@/lib/spec";

export type VenueId = "polymarket" | "kalshi" | "hyperliquid";

export type Side = "yes" | "no";

/** One price level on the ask side: you can BUY `size` shares at `price` ($ per $1 payout). */
export interface Level {
  price: number;
  size: number;
}

/**
 * A market as onebook sees it after extraction.
 * `spec` is null when the extractor did not recognise the rules text. Such
 * markets are shown but NEVER routed: unknown payout = not fungible.
 */
export interface Listing {
  venue: VenueId;
  /** Venue-native market id (Polymarket conditionId, Kalshi ticker, Hyperliquid outcome id). */
  marketId: string;
  title: string;
  url: string;
  spec: PayoutSpec | null;
  /** Why extraction failed, when spec is null. */
  extractError?: string;
  /** Venue-native handle for each leg's order book (token id, ticker+side, coin). */
  legs: Record<Side, string>;
  /** Indicative price per leg from the listing endpoint. Display only; quotes always use live books. */
  preview?: Partial<Record<Side, number>>;
  /** Smallest order the venue accepts, in shares and/or USD notional. */
  minOrder?: { shares?: number; notionalUsd?: number };
  closeTime: string;
  /** Raw resolution text, kept so humans can audit the extractor. */
  rulesText: string;
}

/**
 * Everything onebook needs from a venue. Read-only for now; execution
 * (buildOrder / submit / getPosition) is added per venue in a later step.
 * To add a venue: implement this interface and register it in ./index.ts.
 */
export interface VenueAdapter {
  id: VenueId;
  displayName: string;
  /** Collateral the venue settles in, for the Intents swap target. */
  collateral: { chain: string; asset: string };
  /** Markets onebook currently knows how to extract specs for. */
  listMarkets(): Promise<Listing[]>;
  /** Ask side of the book for one leg, sorted cheapest first. */
  getAsks(listing: Listing, side: Side): Promise<Level[]>;
  /** Taker fee in USD for buying `shares` at `price`. Return 0 if unmodelled. */
  takerFee(shares: number, price: number): number;
}
