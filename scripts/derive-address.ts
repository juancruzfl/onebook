/**
 * Print the Chain Signatures EVM address for a NEAR account. Read-only, free.
 *   npx tsx scripts/derive-address.ts <account.near> [mainnet|testnet]
 */
import { deriveEvmAddress, type NearNetwork } from "../src/lib/near/chainsig";

const [account, network = "mainnet"] = process.argv.slice(2);
if (!account) {
  console.error("usage: tsx scripts/derive-address.ts <account> [mainnet|testnet]");
  process.exit(1);
}
deriveEvmAddress(account, network as NearNetwork).then(
  (r) => console.log(JSON.stringify(r, null, 2)),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
