/**
 * Funding targets: where each venue's collateral lives, per chain, at an address derived from the user's
 * NEAR account (Chain Signatures). NEAR Intents moves money from the NEAR account to these addresses AHEAD
 * of trading, so a trade only needs a signature, not a cross-chain swap.
 *
 * To support a new on-chain venue: add a target (chain, collateral, gas token, address derivation) and
 * list the venue in `venues`. Server-only.
 */
import type { Address } from "viem";
import { polBalance, transferGasCost, usdcBalance } from "@/lib/chains/polygon";
import { ASSETS } from "@/lib/intents/oneclick";
import { deriveEvmAddress } from "@/lib/near/chainsig";
import type { VenueId } from "@/lib/venues/types";

export type TargetId = "polygon";

export interface FundingTarget {
  id: TargetId;
  chain: string;
  /** Venues that trade from this address. */
  venues: VenueId[];
  collateral: { symbol: string; decimals: number; oneClickAsset: string };
  gas: { symbol: string; decimals: number; oneClickAsset: string; topUpYocto: string };
  address: (account: string) => Promise<Address>;
  collateralBalance: (a: Address) => Promise<bigint>;
  gasBalance: (a: Address) => Promise<bigint>;
  /** Gas the address should hold before trading/withdrawing (a few transactions' worth). */
  gasWanted: () => Promise<bigint>;
}

export const TARGETS: Record<TargetId, FundingTarget> = {
  polygon: {
    id: "polygon",
    chain: "Polygon",
    venues: ["polymarket"],
    // TODO(verify): Polymarket V2 settles in pUSD; the USDC → pUSD wrap + exchange approvals belong here
    // as one-time setup once orders are posted for real.
    collateral: { symbol: "USDC", decimals: 6, oneClickAsset: ASSETS.USDC_POLYGON },
    gas: { symbol: "POL", decimals: 18, oneClickAsset: "nep141:pol.omdep.near", topUpYocto: "30000000000000000000000" /* 0.03 NEAR */ },
    address: async (account) => (await deriveEvmAddress(account, "mainnet")).address,
    collateralBalance: usdcBalance,
    gasBalance: polBalance,
    gasWanted: async () => (await transferGasCost()) * BigInt(3),
  },
};

export const targetForVenue = (venue: VenueId): FundingTarget | undefined => Object.values(TARGETS).find((t) => t.venues.includes(venue));
export const isTargetId = (s: string): s is TargetId => s in TARGETS;
