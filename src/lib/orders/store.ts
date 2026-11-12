/** Order queue persistence: one SQLite table, JSON per row. Survives restarts. Server-only. */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OrderRecord, OrderState } from "@/lib/orders/types";

let db: DatabaseSync | null = null;

export function openDb(): DatabaseSync {
  if (db) return db;
  const file = process.env.ONEBOOK_DB ?? path.join(process.cwd(), ".data", "onebook.db");
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, state TEXT NOT NULL, account TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL)`);
  return db;
}

export function saveOrder(o: OrderRecord): void {
  openDb()
    .prepare(
      `INSERT INTO orders (id, state, account, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at, data = excluded.data`,
    )
    .run(o.id, o.state, o.account, o.createdAt, o.updatedAt, JSON.stringify(o));
}

export function getOrder(id: string): OrderRecord | null {
  const row = openDb().prepare("SELECT data FROM orders WHERE id = ?").get(id) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as OrderRecord) : null;
}

export function listOrders(filter: { states?: OrderState[]; account?: string; limit?: number } = {}): OrderRecord[] {
  const where: string[] = [];
  const args: string[] = [];
  if (filter.states?.length) {
    where.push(`state IN (${filter.states.map(() => "?").join(",")})`);
    args.push(...filter.states);
  }
  if (filter.account) {
    where.push("account = ?");
    args.push(filter.account);
  }
  const sql = `SELECT data FROM orders ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ${Math.min(filter.limit ?? 50, 200)}`;
  return (openDb().prepare(sql).all(...args) as { data: string }[]).map((r) => JSON.parse(r.data) as OrderRecord);
}

/** Test hook. */
export function _resetStore(): void {
  db?.close();
  db = null;
}
