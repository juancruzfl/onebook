/**
 * The NEAR transaction that funds a 1Click ORIGIN_CHAIN quote from native NEAR, in one wallet prompt:
 * wrap.near.storage_deposit(depositAddress) → near_deposit (wrap NEAR) → ft_transfer(depositAddress).
 * Browser-safe.
 */
export const WRAP_NEAR = "wrap.near";
/** wrap.near storage registration; refunded if the account is already registered. */
export const WRAP_STORAGE_DEPOSIT = "1250000000000000000000"; // 0.00125 NEAR
const GAS_30T = "30000000000000";
const GAS_50T = "50000000000000";

export function wrapAndDepositTx(depositAddress: string, amountYocto: string) {
  if (!/^\d+$/.test(amountYocto) || BigInt(amountYocto) <= BigInt(0)) throw new Error("amount must be a positive integer (yocto)");
  return {
    receiverId: WRAP_NEAR,
    actions: [
      {
        type: "FunctionCall" as const,
        params: {
          methodName: "storage_deposit",
          args: { account_id: depositAddress, registration_only: true },
          gas: GAS_30T,
          deposit: WRAP_STORAGE_DEPOSIT,
        },
      },
      { type: "FunctionCall" as const, params: { methodName: "near_deposit", args: {}, gas: GAS_30T, deposit: amountYocto } },
      {
        type: "FunctionCall" as const,
        params: { methodName: "ft_transfer", args: { receiver_id: depositAddress, amount: amountYocto }, gas: GAS_50T, deposit: "1" },
      },
    ],
  };
}

/**
 * Fund several 1Click deposit addresses in ONE wallet approval: one storage_deposit per address, a single
 * near_deposit for the total, then one ft_transfer per address. All actions go to wrap.near.
 */
export function wrapAndDepositManyTx(deposits: { depositAddress: string; amountYocto: string }[]) {
  if (deposits.length === 0 || deposits.length > 3) throw new Error("1-3 deposits per transaction");
  for (const d of deposits)
    if (!/^\d+$/.test(d.amountYocto) || BigInt(d.amountYocto) <= BigInt(0)) throw new Error("amount must be a positive integer (yocto)");
  const total = deposits.reduce((s, d) => s + BigInt(d.amountYocto), BigInt(0)).toString();
  return {
    receiverId: WRAP_NEAR,
    actions: [
      ...deposits.map((d) => ({
        type: "FunctionCall" as const,
        params: {
          methodName: "storage_deposit",
          args: { account_id: d.depositAddress, registration_only: true },
          gas: GAS_30T,
          deposit: WRAP_STORAGE_DEPOSIT,
        },
      })),
      { type: "FunctionCall" as const, params: { methodName: "near_deposit", args: {}, gas: GAS_30T, deposit: total } },
      ...deposits.map((d) => ({
        type: "FunctionCall" as const,
        params: { methodName: "ft_transfer", args: { receiver_id: d.depositAddress, amount: d.amountYocto }, gas: GAS_50T, deposit: "1" },
      })),
    ],
  };
}
