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
