/** Constants shared by browser and server code (no chainsig.js import here). */
export type NearNetwork = "mainnet" | "testnet";

/** MPC signer contracts (docs.near.org → Chain Signatures). */
export const MPC_CONTRACT: Record<NearNetwork, string> = {
  mainnet: "v1.signer",
  testnet: "v1.signer-prod.testnet",
};

/**
 * Derivation path for a user's EVM address. One path = one address on every EVM chain.
 * Changing this string changes every user's address, so treat it as a constant forever.
 */
export const EVM_PATH = "onebook-evm-1";

/** NEAR account id rules. */
export const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export const isAccountId = (s: string) => s.length >= 2 && s.length <= 64 && ACCOUNT_RE.test(s);
