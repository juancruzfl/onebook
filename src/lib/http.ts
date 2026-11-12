/**
 * Identify honestly as an application. Some venue CDNs (Polymarket US / Cloudflare) throttle Node's default
 * "node" user agent hard; a descriptive one is served normally. Never impersonate a browser or another tool.
 */
export const USER_AGENT = "onebook-router/0.1";

/** Small fetch wrapper: JSON, timeout, no caching (market data goes stale in seconds). */
export async function getJson<T>(url: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const res = await fetch(url, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(init?.timeoutMs ?? 10_000),
    headers: { Accept: "application/json", "User-Agent": USER_AGENT, ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Round to 4 decimals to undo float noise from 1 - p conversions. */
export const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
