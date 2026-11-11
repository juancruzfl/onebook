import { describe, expect, it } from "vitest";
import { deriveEvmAddress, EVM_PATH } from "@/lib/near/chainsig";

describe("chain signatures derivation", () => {
  it("is deterministic and matches the v1.signer contract's derived_public_key (checked 2026-11-11)", async () => {
    // chainsig.js derives locally from the MPC root key, so this needs no network.
    const r = await deriveEvmAddress("example.near", "mainnet");
    expect(EVM_PATH).toBe("onebook-evm-1");
    expect(r.address).toBe("0x614ed9cC94913BFb33d7a70A8460547379Ca8D0E");
  });

  it("gives different accounts different addresses", async () => {
    const [a, b] = await Promise.all([deriveEvmAddress("alice.near"), deriveEvmAddress("bob.near")]);
    expect(a.address).not.toBe(b.address);
  });
});
