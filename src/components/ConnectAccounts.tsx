"use client";

import { useState } from "react";
import { VenueLogo } from "@/components/Logos";
import { removeConnection, saveConnection, type VenueConnection } from "@/lib/live/browser-keys";
import { balanceUsd, checkConnection } from "@/lib/live/client";
import { LIVE_VENUES, type LiveVenue } from "@/lib/live/orders";
import { fmtUsd, VENUE } from "@/lib/present";

const HELP: Record<LiveVenue, { where: string; secretLabel: string; placeholder: string }> = {
  "polymarket-us": {
    where: "polymarket.us/developer (after identity verification in the Polymarket US app)",
    secretLabel: "Secret key",
    placeholder: "base64 secret shown once when you created the key",
  },
  kalshi: {
    where: "kalshi.com → Account & security → API keys",
    secretLabel: "Private key",
    placeholder: "-----BEGIN RSA PRIVATE KEY-----\n…\n-----END RSA PRIVATE KEY-----",
  },
};

/** Connect the user's own regulated-venue accounts with their API keys. Keys stay in this browser. */
export function ConnectAccounts({
  connections,
  onChange,
}: {
  connections: Partial<Record<LiveVenue, VenueConnection>>;
  onChange: () => void;
}) {
  const [open, setOpen] = useState<LiveVenue | null>(null);
  const [keyId, setKeyId] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [balances, setBalances] = useState<Partial<Record<LiveVenue, string>>>({});

  async function connect(venue: LiveVenue) {
    setBusy(true);
    setError(null);
    try {
      const c = await saveConnection(venue, keyId, secret);
      try {
        const usd = balanceUsd(venue, await checkConnection(c));
        setBalances((b) => ({ ...b, [venue]: usd === null ? "connected" : `${fmtUsd(usd)} available` }));
      } catch (e) {
        await removeConnection(venue);
        throw new Error(`${VENUE[venue].name} rejected the key: ${(e as Error).message}`);
      }
      setOpen(null);
      setKeyId("");
      setSecret("");
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(venue: LiveVenue) {
    await removeConnection(venue);
    setBalances((b) => ({ ...b, [venue]: undefined }));
    onChange();
  }

  return (
    <div className="accounts">
      {LIVE_VENUES.map((v) => {
        const c = connections[v];
        return (
          <div key={v} className="account-row">
            <div className="route-row">
              <VenueLogo venue={v} />
              <span>{VENUE[v].name}</span>
              {c ? (
                <span className="muted small">
                  {balances[v] ?? "connected"} ·{" "}
                  <button className="link-btn" onClick={() => disconnect(v)}>
                    disconnect
                  </button>
                </span>
              ) : (
                <button className="chip-btn" onClick={() => (setOpen(open === v ? null : v), setError(null))}>
                  {open === v ? "Cancel" : "Connect API key"}
                </button>
              )}
            </div>
            {open === v && !c && (
              <div className="connect-form">
                <p className="muted tiny">Create a key at {HELP[v].where}.</p>
                <input placeholder="Key ID" value={keyId} onChange={(e) => setKeyId(e.target.value)} autoComplete="off" spellCheck={false} />
                <textarea
                  placeholder={HELP[v].placeholder}
                  aria-label={HELP[v].secretLabel}
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  rows={v === "kalshi" ? 4 : 2}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button className="chip-btn" disabled={busy || !keyId || !secret} onClick={() => connect(v)}>
                  {busy ? "Checking…" : `Connect ${VENUE[v].name}`}
                </button>
              </div>
            )}
          </div>
        );
      })}
      {error && <p className="err-text small">{error}</p>}
      <p className="muted tiny">
        Your keys stay in this browser as non-exportable keys. onebook&apos;s server never receives them; it only
        sees one-time signatures for the orders you confirm.
      </p>
    </div>
  );
}
