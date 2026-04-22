// SQLite persistence for scanned Shop Goodwill items.

import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "data.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  id               INTEGER PRIMARY KEY,
  title            TEXT NOT NULL,
  url              TEXT NOT NULL,
  image_url        TEXT,
  current_bid      REAL NOT NULL,
  end_time         TEXT NOT NULL,
  estimated_resale REAL,
  confidence       TEXT,
  reasoning        TEXT,
  sources          TEXT,
  total_cost       REAL,
  profit           REAL,
  profit_pct       REAL,
  max_bid          REAL,
  status           TEXT NOT NULL DEFAULT 'active',
  model_mode       TEXT,
  scanned_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
CREATE INDEX IF NOT EXISTS idx_items_end_time ON items(end_time);
`;

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(SCHEMA);

const stmtUpsert = db.prepare(`
INSERT INTO items (
  id, title, url, image_url, current_bid, end_time,
  estimated_resale, confidence, reasoning, sources,
  total_cost, profit, profit_pct, max_bid,
  status, model_mode, scanned_at
) VALUES (
  @id, @title, @url, @image_url, @current_bid, @end_time,
  @estimated_resale, @confidence, @reasoning, @sources,
  @total_cost, @profit, @profit_pct, @max_bid,
  'active', @model_mode, @scanned_at
)
ON CONFLICT(id) DO UPDATE SET
  title=excluded.title,
  url=excluded.url,
  image_url=excluded.image_url,
  current_bid=excluded.current_bid,
  end_time=excluded.end_time,
  estimated_resale=excluded.estimated_resale,
  confidence=excluded.confidence,
  reasoning=excluded.reasoning,
  sources=excluded.sources,
  total_cost=excluded.total_cost,
  profit=excluded.profit,
  profit_pct=excluded.profit_pct,
  max_bid=excluded.max_bid,
  status='active',
  model_mode=excluded.model_mode,
  scanned_at=excluded.scanned_at
`);

const stmtMarkExpired = db.prepare(
  `UPDATE items SET status='closed' WHERE status='active' AND end_time < ?`
);
const stmtDeleteClosed = db.prepare(`DELETE FROM items WHERE status='closed'`);
const stmtGetAll = db.prepare(
  `SELECT * FROM items ORDER BY (status = 'closed') ASC, end_time ASC`
);
const stmtGetOne = db.prepare(`SELECT * FROM items WHERE id = ?`);

export function upsertAnalyzed(row) {
  stmtUpsert.run({
    id: row.itemId,
    title: row.title,
    url: row.url,
    image_url: row.imageUrl ?? "",
    current_bid: row.currentBid,
    end_time:
      row.endTime instanceof Date ? row.endTime.toISOString() : String(row.endTime),
    estimated_resale: row.estimatedResale,
    confidence: row.confidence,
    reasoning: row.reasoning,
    sources: JSON.stringify(row.sources ?? []),
    total_cost: row.totalCost,
    profit: row.profit,
    profit_pct: row.profitPct,
    max_bid: row.maxBid,
    model_mode: row.modelMode,
    scanned_at: new Date().toISOString(),
  });
}

export function existingIds(ids) {
  const list = Array.from(ids);
  if (list.length === 0) return new Set();
  const placeholders = list.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT id FROM items WHERE id IN (${placeholders})`)
    .all(...list);
  return new Set(rows.map((r) => r.id));
}

export function markExpiredClosed() {
  const nowIso = new Date().toISOString();
  const info = stmtMarkExpired.run(nowIso);
  return info.changes;
}

export function deleteClosed() {
  const info = stmtDeleteClosed.run();
  return info.changes;
}

function hydrate(row) {
  if (!row) return null;
  return { ...row, sources: row.sources ? JSON.parse(row.sources) : [] };
}

export function getAll() {
  return stmtGetAll.all().map(hydrate);
}

export function getOne(id) {
  return hydrate(stmtGetOne.get(id));
}
