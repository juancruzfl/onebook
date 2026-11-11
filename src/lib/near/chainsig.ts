import { chainAdapters, contracts } from "chainsig.js";
import { createPublicClient, http, type Chain } from "viem";
import { polygon } from "viem/chains";

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

export function mpcContract(network: NearNetwork) {
  return new contracts.ChainSignatureContract({ networkId: network, contractId: MPC_CONTRACT[network] });
}

export function evmAdapter(network: NearNetwork, chain: Chain = polygon, rpcUrl?: string) {
  return new chainAdapters.evm.EVM({
    publicClient: createPublicClient({ chain, transport: http(rpcUrl) }),
    contract: mpcContract(network),
  });
}

/** Read-only: the EVM address that only `accountId` can sign for (via the MPC network). */
export async function deriveEvmAddress(accountId: string, network: NearNetwork = "mainnet") {
  const { address, publicKey } = await evmAdapter(network).deriveAddressAndPublicKey(accountId, EVM_PATH);
  return { address: address as `0x${string}`, publicKey, path: EVM_PATH, network };
}
