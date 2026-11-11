/**
 * Polymarket CLOB V2 order, EIP-712 (live since 2026-04-28, docs.polymarket.com/v2-migration).
 * Only the typed data is built here; nothing is posted to Polymarket (dry run, see README → Compliance).
 */
import { hashTypedData, zeroHash, type Address, type Hex, type TypedDataDefinition } from "viem";

export const POLYMARKET_EXCHANGE_V2 = {
  standard: "0xE111180000d2663C0091e4f400237545B87B996B",
  negRisk: "0xe2222d279d744050d28e00520010520000310F59",
} as const satisfies Record<string, Address>;

export const ORDER_TYPES = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "signatureType", type: "uint8" },
    { name: "timestamp", type: "uint256" },
    { name: "metadata", type: "bytes32" },
    { name: "builder", type: "bytes32" },
  ],
} as const;

export const SIDE = { BUY: 0, SELL: 1 } as const;
/** 0 = plain EOA signature: the Chain Signatures address signs for itself. TODO(verify) value meanings for V2. */
export const SIGNATURE_TYPE_EOA = 0;

/** JSON-safe order (uint256 as decimal strings) so it can travel between browser and server. */
export interface OrderJson {
  salt: string;
  maker: Address;
  signer: Address;
  tokenId: string;
  makerAmount: string;
  takerAmount: string;
  side: number;
  signatureType: number;
  timestamp: string;
  metadata: Hex;
  builder: Hex;
}

export interface BuyOrderInput {
  maker: Address;
  tokenId: string;
  /** Price in dollars per share (0-1) and number of shares. Collateral has 6 decimals. */
  price: number;
  shares: number;
  negRisk?: boolean;
  nowMs?: number;
}

const toUnits = (x: number) => BigInt(Math.round(x * 1e6));

/** A BUY: pay makerAmount collateral, receive takerAmount outcome shares (both 6 decimals). */
export function buildBuyOrder(i: BuyOrderInput): { order: OrderJson; exchange: Address } {
  if (!(i.price > 0 && i.price < 1)) throw new Error("price must be in (0,1)");
  if (!(i.shares > 0)) throw new Error("shares must be > 0");
  const salt = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
  return {
    exchange: i.negRisk ? POLYMARKET_EXCHANGE_V2.negRisk : POLYMARKET_EXCHANGE_V2.standard,
    order: {
      salt: salt.toString(),
      maker: i.maker,
      signer: i.maker,
      tokenId: i.tokenId,
      makerAmount: toUnits(i.price * i.shares).toString(),
      takerAmount: toUnits(i.shares).toString(),
      side: SIDE.BUY,
      signatureType: SIGNATURE_TYPE_EOA,
      timestamp: String(i.nowMs ?? Date.now()), // TODO(verify): ms vs s in V2
      metadata: zeroHash,
      builder: zeroHash,
    },
  };
}

export function orderTypedData(order: OrderJson, exchange: Address): TypedDataDefinition<typeof ORDER_TYPES, "Order"> {
  return {
    domain: { name: "Polymarket CTF Exchange", version: "2", chainId: 137, verifyingContract: exchange },
    types: ORDER_TYPES,
    primaryType: "Order",
    message: {
      salt: BigInt(order.salt),
      maker: order.maker,
      signer: order.signer,
      tokenId: BigInt(order.tokenId),
      makerAmount: BigInt(order.makerAmount),
      takerAmount: BigInt(order.takerAmount),
      side: order.side,
      signatureType: order.signatureType,
      timestamp: BigInt(order.timestamp),
      metadata: order.metadata,
      builder: order.builder,
    },
  };
}

export const orderHash = (order: OrderJson, exchange: Address): Hex => hashTypedData(orderTypedData(order, exchange));
