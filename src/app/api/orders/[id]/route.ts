import { NextResponse } from "next/server";
import { advance } from "@/lib/orders/engine";

export const dynamic = "force-dynamic";

/** GET /api/orders/:id : current state; also nudges the order forward one step. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const order = await advance(id);
  if (!order) return NextResponse.json({ error: "order not found" }, { status: 404 });
  return NextResponse.json({ order });
}
