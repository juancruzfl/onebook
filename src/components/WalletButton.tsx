"use client";

import { useWallet } from "@/components/WalletProvider";

export function WalletButton() {
  const { accountId, connecting, connect, disconnect } = useWallet();
  if (!accountId)
    return (
      <button onClick={connect} disabled={connecting}>
        {connecting ? "Connecting…" : "Connect wallet"}
      </button>
    );
  return (
    <span className="wallet">
      <span className="wallet-id" title={accountId}>
        {accountId}
      </span>
      <button className="link" onClick={disconnect}>
        Disconnect
      </button>
    </span>
  );
}
