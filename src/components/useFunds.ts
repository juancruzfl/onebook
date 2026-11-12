"use client";

import { useEffect, useState } from "react";

export interface FundsInfo {
  evmAddress: string;
  /** USDC, 6-decimal units. */
  usdc: string;
  /** POL, wei. */
  pol: string;
  needsGas: boolean;
  maxFundUsd: number;
}

/** One shared balance per account across components; any component can ask for a refresh. */
const listeners = new Set<() => void>();
const cache = new Map<string, FundsInfo>();
export const refreshFunds = () => listeners.forEach((l) => l());

export function useFunds(accountId: string | null): FundsInfo | null {
  const [info, setInfo] = useState<FundsInfo | null>(accountId ? (cache.get(accountId) ?? null) : null);
  useEffect(() => {
    if (!accountId) return setInfo(null);
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/funds?account=${encodeURIComponent(accountId)}`);
        if (!res.ok) return;
        const json = (await res.json()) as FundsInfo;
        cache.set(accountId, json);
        if (alive) setInfo(json);
      } catch {
        /* keep last */
      }
    };
    load();
    listeners.add(load);
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      listeners.delete(load);
      clearInterval(t);
    };
  }, [accountId]);
  return info;
}

export const usdcOf = (f: FundsInfo | null) => (f ? Number(f.usdc) / 1e6 : 0);
