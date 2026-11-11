/**
 * Browser- and server-safe helpers for the MPC `sign` call. Mirrors chainsig.js's request format
 * (ChainSignatureContract.sign) without pulling the whole multi-chain SDK into the browser bundle.
 */
import { concatHex, numberToHex, type Hex } from "viem";
import { EVM_PATH, MPC_CONTRACT, type NearNetwork } from "@/lib/near/chain-constants";

/** 300 TGas prepaid (unused gas is refunded) and exactly 1 yoctoNEAR, as chainsig.js sends. */
export const MPC_SIGN_GAS = "300000000000000";
export const MPC_SIGN_DEPOSIT = "1";

export interface MpcSignTx {
  receiverId: string;
  actions: { type: "FunctionCall"; params: { methodName: "sign"; args: object; gas: string; deposit: string } }[];
}

/** The NEAR transaction a wallet must sign to have the MPC network sign `hash` (32 bytes, hex). */
export function mpcSignTx(hash: Hex, network: NearNetwork = "mainnet", path = EVM_PATH): MpcSignTx {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("hash must be 32 bytes hex");
  return {
    receiverId: MPC_CONTRACT[network],
    actions: [
      {
        type: "FunctionCall",
        params: {
          methodName: "sign",
          args: { request: { payload_v2: { Ecdsa: hash.slice(2) }, path, domain_id: 0 } },
          gas: MPC_SIGN_GAS,
          deposit: MPC_SIGN_DEPOSIT,
        },
      },
    ],
  };
}

/** Shapes the MPC contract has returned for ECDSA signatures (same cases chainsig.js handles). */
type MpcEcdsaResult =
  | { big_r: { affine_point: string }; s: { scalar: string }; recovery_id: number }
  | { big_r: string; s: string; recovery_id: number };

/** Convert the contract's return value into a 65-byte r||s||v EVM signature. */
export function mpcResultToEvmSignature(result: unknown): Hex {
  const r = result as MpcEcdsaResult & { scheme?: string };
  if (!r || typeof r !== "object" || !("recovery_id" in r)) throw new Error("not an ECDSA MPC signature");
  const bigR = typeof r.big_r === "string" ? r.big_r : r.big_r.affine_point;
  const s = typeof r.s === "string" ? r.s : r.s.scalar;
  // big_r is a compressed point (02/03 prefix + x); r is its x coordinate.
  const rHex = bigR.slice(2).padStart(64, "0");
  return concatHex([`0x${rHex}`, `0x${s.padStart(64, "0")}`, numberToHex(r.recovery_id + 27, { size: 1 })]);
}
