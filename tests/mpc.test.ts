import { describe, expect, it } from "vitest";
import { recoverTypedDataAddress } from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import { mpcResultToEvmSignature, mpcSignTx } from "@/lib/near/mpc";
import { buildBuyOrder, orderHash, orderTypedData } from "@/lib/polymarket/order";

// Throwaway test key (well-known Hardhat account #0). Never holds funds.
const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const acct = privateKeyToAccount(PK);

describe("MPC signature conversion", () => {
  it("turns an MPC-style ECDSA result into a signature that recovers the signer", async () => {
    const { order, exchange } = buildBuyOrder({ maker: acct.address, tokenId: "123", price: 0.42, shares: 10, nowMs: 1_794_438_000_000 });
    const hash = orderHash(order, exchange);
    const sig = await sign({ hash, privateKey: PK });
    // Shape the v1.signer contract returns: compressed R point, scalar s, recovery id.
    const mpcResult = {
      big_r: { affine_point: `${sig.yParity ? "03" : "02"}${sig.r.slice(2).toUpperCase()}` },
      s: { scalar: sig.s.slice(2).toUpperCase() },
      recovery_id: sig.yParity,
    };
    const signature = mpcResultToEvmSignature(mpcResult);
    expect(await recoverTypedDataAddress({ ...orderTypedData(order, exchange), signature })).toBe(acct.address);
  });

  it("builds the v1.signer sign call with 1 yocto and the onebook path", () => {
    const tx = mpcSignTx(`0x${"ab".repeat(32)}`);
    expect(tx.receiverId).toBe("v1.signer");
    expect(tx.actions[0].params).toMatchObject({
      methodName: "sign",
      deposit: "1",
      args: { request: { payload_v2: { Ecdsa: "ab".repeat(32) }, path: "onebook-evm-1", domain_id: 0 } },
    });
  });

  it("rejects non-32-byte hashes", () => {
    expect(() => mpcSignTx("0x1234")).toThrow();
  });
});

describe("Polymarket V2 BUY order", () => {
  it("encodes price and size in 6-decimal units", () => {
    const { order } = buildBuyOrder({ maker: acct.address, tokenId: "1", price: 0.42, shares: 10 });
    expect([order.makerAmount, order.takerAmount, order.side]).toEqual(["4200000", "10000000", 0]);
  });
});
