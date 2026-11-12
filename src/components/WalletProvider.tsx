"use client";

/**
 * Connect-wallet state for the whole app, via HOT's near-connect (supports NEAR Mobile, HOT, Meteor,
 * Intear, MyNearWallet, …). Keys never leave the user's wallet: the app only asks it to sign.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { NearConnector, NearWalletBase } from "@hot-labs/near-connect";

interface WalletState {
  accountId: string | null;
  walletName: string | null;
  connecting: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  /** Sign and send one transaction with the connected wallet; resolves to the parsed return value. */
  signAndSend: (tx: { receiverId: string; actions: unknown[] }) => Promise<{ result: unknown; txHash?: string }>;
}

const Ctx = createContext<WalletState | null>(null);

export function useWallet(): WalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet must be used inside <WalletProvider>");
  return v;
}

/** FinalExecutionOutcome.status.SuccessValue is base64 JSON. */
function parseOutcome(outcome: unknown): { result: unknown; txHash?: string } {
  const o = outcome as { status?: { SuccessValue?: string; Failure?: unknown }; transaction?: { hash?: string } };
  if (o?.status && "Failure" in o.status && o.status.Failure) throw new Error(`transaction failed: ${JSON.stringify(o.status.Failure)}`);
  const b64 = o?.status?.SuccessValue;
  if (b64 === undefined) throw new Error("transaction did not succeed");
  // Some calls (e.g. ft_transfer) succeed with an empty return value.
  return { result: b64 === "" ? null : JSON.parse(atob(b64)), txHash: o.transaction?.hash };
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const connector = useRef<NearConnector | null>(null);
  const [wallet, setWallet] = useState<NearWalletBase | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const getConnector = useCallback(async () => {
    if (!connector.current) {
      const { NearConnector } = await import("@hot-labs/near-connect");
      const c = new NearConnector({ network: "mainnet" });
      c.on("wallet:signIn", async (e) => {
        setWallet(await c.wallet());
        setAccountId(e.accounts[0]?.accountId ?? null);
      });
      c.on("wallet:signOut", () => {
        setWallet(null);
        setAccountId(null);
      });
      connector.current = c;
    }
    return connector.current;
  }, []);

  // Restore a previous session on load.
  useEffect(() => {
    (async () => {
      try {
        const c = await getConnector();
        const { wallet: w, accounts } = await c.getConnectedWallet();
        setWallet(w);
        setAccountId(accounts[0]?.accountId ?? null);
      } catch {
        /* not connected yet */
      }
    })();
  }, [getConnector]);

  const connect = useCallback(async () => {
    setConnecting(true);
    try {
      await (await getConnector()).connect();
    } finally {
      setConnecting(false);
    }
  }, [getConnector]);

  const disconnect = useCallback(async () => {
    await (await getConnector()).disconnect();
    setWallet(null);
    setAccountId(null);
  }, [getConnector]);

  const signAndSend = useCallback(
    async (tx: { receiverId: string; actions: unknown[] }) => {
      if (!wallet || !accountId) throw new Error("connect a wallet first");
      const outcome = await wallet.signAndSendTransaction({
        signerId: accountId,
        receiverId: tx.receiverId,
        actions: tx.actions as Parameters<NearWalletBase["signAndSendTransaction"]>[0]["actions"],
      });
      return parseOutcome(outcome);
    },
    [wallet, accountId],
  );

  return (
    <Ctx.Provider value={{ accountId, walletName: wallet?.manifest?.name ?? null, connecting, connect, disconnect, signAndSend }}>
      {children}
    </Ctx.Provider>
  );
}
