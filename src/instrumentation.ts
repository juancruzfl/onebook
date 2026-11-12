/** Runs once when the Next.js server starts: the worker for orders, withdrawals and fundings. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.ONEBOOK_WORKER === "off") return;
  const { tickAll } = await import("@/lib/orders/engine");
  const { tickWithdrawals } = await import("@/lib/withdraw/engine");
  const { tickFundings } = await import("@/lib/funding/engine");
  const g = globalThis as unknown as { __onebookWorker?: NodeJS.Timeout };
  if (g.__onebookWorker) return; // dev hot reload
  g.__onebookWorker = setInterval(() => {
    tickAll().catch((e) => console.warn("[orders] tick failed:", (e as Error).message));
    tickWithdrawals().catch((e) => console.warn("[withdraw] tick failed:", (e as Error).message));
    tickFundings().catch((e) => console.warn("[funding] tick failed:", (e as Error).message));
  }, 5000);
}
