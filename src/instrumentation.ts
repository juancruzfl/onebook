/** Runs once when the Next.js server starts: the execution-queue worker. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.ONEBOOK_WORKER === "off") return;
  const { tickAll } = await import("@/lib/orders/engine");
  const g = globalThis as unknown as { __onebookWorker?: NodeJS.Timeout };
  if (g.__onebookWorker) return; // dev hot reload
  g.__onebookWorker = setInterval(() => {
    tickAll().catch((e) => console.warn("[orders] tick failed:", (e as Error).message));
  }, 5000);
}
