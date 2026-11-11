import { chainAdapters, contracts } from "chainsig.js";
import { createPublicClient, http, type Chain } from "viem";
import { polygon } from "viem/chains";

import { EVM_PATH, MPC_CONTRACT, type NearNetwork } from "@/lib/near/chain-constants";

export { EVM_PATH, MPC_CONTRACT, type NearNetwork };

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
