/**
 * Polygon reads and transactions for the user's Chain Signatures address. Server-only.
 * Transactions are built here, signed by the user's NEAR account through the MPC network, and broadcast here.
 */
import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  fallback,
  http,
  isAddressEqual,
  keccak256,
  parseGwei,
  recoverTransactionAddress,
  serializeTransaction,
  type Address,
  type Hex,
  type TransactionSerializableEIP1559,
} from "viem";
import { polygon } from "viem/chains";
import { USDC_POLYGON_ADDRESS } from "@/lib/intents/oneclick";

/**
 * Public Polygon RPCs, tried in order (viem's default, polygon-rpc.com, now answers "tenant disabled").
 * POLYGON_RPC_URL, if set, goes first. Verified 2026-11-12.
 */
export const POLYGON_RPCS = ["https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org", "https://1rpc.io/matic"];

export const polygonClient = () =>
  createPublicClient({
    chain: polygon,
    transport: fallback([process.env.POLYGON_RPC_URL, ...POLYGON_RPCS].filter((u): u is string => !!u).map((u) => http(u, { timeout: 8_000 }))),
  });

export const usdcBalance = (address: Address) =>
  polygonClient().readContract({ address: USDC_POLYGON_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [address] });

export const polBalance = (address: Address) => polygonClient().getBalance({ address });

/** Polygon requires a priority fee of at least ~25-30 gwei; stay above it. */
const MIN_TIP = parseGwei("30");
/** A USDC transfer uses ~45-65k gas; estimate and keep a margin. */
const TRANSFER_GAS_FALLBACK = BigInt(90_000);

/** A JSON-safe copy of an unsigned EIP-1559 tx (bigints as decimal strings). */
export interface UnsignedTxJson {
  chainId: number;
  nonce: number;
  to: Address;
  data: Hex;
  value: string;
  gas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
}

export const toTx = (j: UnsignedTxJson): TransactionSerializableEIP1559 => ({
  type: "eip1559",
  chainId: j.chainId,
  nonce: j.nonce,
  to: j.to,
  data: j.data,
  value: BigInt(j.value),
  gas: BigInt(j.gas),
  maxFeePerGas: BigInt(j.maxFeePerGas),
  maxPriorityFeePerGas: BigInt(j.maxPriorityFeePerGas),
});

/** Hash the MPC network must sign for this transaction. */
export const txSigningHash = (j: UnsignedTxJson): Hex => keccak256(serializeTransaction(toTx(j)));

/** EIP-1559 fees with Polygon's minimum tip and 2x base-fee headroom (the user signs between build and send). */
async function fees(): Promise<{ maxFee: bigint; tip: bigint }> {
  const f = await polygonClient().estimateFeesPerGas();
  const tip = f.maxPriorityFeePerGas > MIN_TIP ? f.maxPriorityFeePerGas : MIN_TIP;
  const maxFee = f.maxFeePerGas * BigInt(2) > tip * BigInt(2) ? f.maxFeePerGas * BigInt(2) : tip * BigInt(2);
  return { maxFee, tip };
}
const withMargin = (gas: bigint) => (gas * BigInt(13)) / BigInt(10);

/**
 * POL the address must hold for one USDC transfer: nodes only accept a transaction when the sender can
 * cover gas × maxFeePerGas (the actual charge is usually far lower).
 */
export async function transferGasCost(): Promise<bigint> {
  return withMargin(TRANSFER_GAS_FALLBACK) * (await fees()).maxFee;
}

/** Unsigned USDC.transfer(to, amount) from `from`, with current nonce and fees. */
export async function buildUsdcTransfer(from: Address, to: Address, amount: bigint): Promise<UnsignedTxJson> {
  const client = polygonClient();
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] });
  const [nonce, { maxFee, tip }, est] = await Promise.all([
    client.getTransactionCount({ address: from, blockTag: "pending" }),
    fees(),
    client.estimateGas({ account: from, to: USDC_POLYGON_ADDRESS, data }).catch(() => TRANSFER_GAS_FALLBACK),
  ]);
  return {
    chainId: polygon.id,
    nonce,
    to: USDC_POLYGON_ADDRESS,
    data,
    value: "0",
    // Never above what transferGasCost() budgeted for.
    gas: (withMargin(est) < withMargin(TRANSFER_GAS_FALLBACK) ? withMargin(est) : withMargin(TRANSFER_GAS_FALLBACK)).toString(),
    maxFeePerGas: maxFee.toString(),
    maxPriorityFeePerGas: tip.toString(),
  };
}

/** Attach a 65-byte r||s||v signature; refuses unless it recovers to `expectedFrom`. */
export async function signedTransaction(j: UnsignedTxJson, signature: Hex, expectedFrom: Address): Promise<Hex> {
  const r = `0x${signature.slice(2, 66)}` as Hex;
  const s = `0x${signature.slice(66, 130)}` as Hex;
  const v = parseInt(signature.slice(130, 132), 16);
  const yParity = v >= 27 ? v - 27 : v;
  const raw = serializeTransaction(toTx(j), { r, s, yParity });
  const from = await recoverTransactionAddress({ serializedTransaction: raw as Parameters<typeof recoverTransactionAddress>[0]["serializedTransaction"] });
  if (!isAddressEqual(from, expectedFrom)) throw new Error(`signature recovers to ${from}, expected ${expectedFrom}`);
  return raw;
}

export const broadcast = (raw: Hex) => polygonClient().sendRawTransaction({ serializedTransaction: raw });

export async function receiptStatus(hash: Hex): Promise<"success" | "reverted" | "pending"> {
  try {
    return (await polygonClient().getTransactionReceipt({ hash })).status;
  } catch {
    return "pending";
  }
}
