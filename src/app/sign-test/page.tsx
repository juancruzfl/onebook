"use client";

import Link from "next/link";
import { useState } from "react";
import { useWallet } from "@/components/WalletProvider";
import { WalletButton } from "@/components/WalletButton";

type Step = "idle" | "preparing" | "awaiting-wallet" | "verifying" | "done" | "error";

interface Prepared {
  evmAddress: string;
  order: Record<string, unknown>;
  exchange: string;
  hash: string;
  nearTx: { receiverId: string; actions: unknown[] };
}

/**
 * Proof that a NEAR account can sign a Polymarket order through Chain Signatures.
 * Costs a little NEAR gas (unused gas is refunded) + 1 yoctoNEAR. Nothing is sent to Polymarket.
 */
export default function SignTest() {
  const { accountId, signAndSend } = useWallet();
  const [step, setStep] = useState<Step>("idle");
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [verdict, setVerdict] = useState<{ valid: boolean; recovered: string; signature: string; txHash?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!accountId) return;
    setError(null);
    setVerdict(null);
    try {
      setStep("preparing");
      const prep = await fetch("/api/sign/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: accountId }),
      });
      const p = (await prep.json()) as Prepared & { error?: string };
      if (!prep.ok) throw new Error(p.error ?? `HTTP ${prep.status}`);
      setPrepared(p);

      setStep("awaiting-wallet");
      const { result, txHash } = await signAndSend(p.nearTx);

      setStep("verifying");
      const ver = await fetch("/api/sign/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: accountId, order: p.order, exchange: p.exchange, mpcResult: result }),
      });
      const v = await ver.json();
      if (!ver.ok) throw new Error(v.error ?? `HTTP ${ver.status}`);
      setVerdict({ ...v, txHash });
      setStep("done");
    } catch (e) {
      setError((e as Error).message);
      setStep("error");
    }
  }

  const label: Record<Step, string> = {
    idle: "Sign a test order",
    preparing: "Preparing…",
    "awaiting-wallet": "Approve in your wallet…",
    verifying: "Checking signature…",
    done: "Sign another",
    error: "Try again",
  };
  const busy = step === "preparing" || step === "awaiting-wallet" || step === "verifying";

  return (
    <main className="wrap">
      <header className="top">
        <div>
          <h1>Chain Signatures test</h1>
          <p className="muted">
            Your NEAR account signs a sample Polymarket order through NEAR&apos;s MPC network. Nothing is sent to
            Polymarket and no funds move. <Link href="/">← back</Link>
          </p>
        </div>
        <WalletButton />
      </header>

      <section className="card">
        <ol className="steps">
          <li>We build a Polymarket order whose owner is the address your NEAR account controls.</li>
          <li>
            Your wallet asks you to approve one NEAR transaction to <code>v1.signer</code> (the MPC network). It
            attaches 1 yoctoNEAR and up to 300 TGas; unused gas is refunded.
          </li>
          <li>We check that the returned signature really comes from your address.</li>
        </ol>
        <div className="row" style={{ marginTop: 12 }}>
          <button onClick={run} disabled={!accountId || busy}>
            {accountId ? label[step] : "Connect a wallet first"}
          </button>
        </div>
        {prepared && (
          <p className="small mono" style={{ marginTop: 12 }}>
            Your Polygon address: {prepared.evmAddress}
            <br />
            Order hash: {prepared.hash}
          </p>
        )}
        {error && <p className="err-text">{error}</p>}
        {verdict && (
          <p className={verdict.valid ? "ok-text" : "err-text"} style={{ marginTop: 12 }}>
            {verdict.valid ? "✓ Valid: the order was signed by your address." : "✗ Signature does not match your address."}
            <br />
            <span className="small mono">recovered {verdict.recovered}</span>
            {verdict.txHash && (
              <>
                <br />
                <a className="small" href={`https://nearblocks.io/txns/${verdict.txHash}`} target="_blank" rel="noreferrer">
                  View NEAR transaction ↗
                </a>
              </>
            )}
          </p>
        )}
      </section>
    </main>
  );
}
