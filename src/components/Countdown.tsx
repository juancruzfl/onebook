"use client";

import { useEffect, useState } from "react";

/** "Closes in 4:12" style countdown; switches to h/d for long horizons. */
export function Countdown({ to, prefix = "Closes in" }: { to: string; prefix?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const ms = new Date(to).getTime() - now;
  if (ms <= 0) return <span className="countdown done">Closed</span>;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const text =
    h >= 48 ? `${Math.floor(h / 24)}d` : h >= 1 ? `${h}h ${m}m` : `${m}:${String(sec).padStart(2, "0")}`;
  return (
    <span className={`countdown ${s < 120 ? "soon" : ""}`}>
      {prefix} {text}
    </span>
  );
}
