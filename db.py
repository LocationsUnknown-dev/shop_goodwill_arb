"""SQLite persistence for scanned Shop Goodwill items."""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

DB_PATH = Path(__file__).parent / "data.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
    id            INTEGER PRIMARY KEY,
    title         TEXT NOT NULL,
    url           TEXT NOT NULL,
    image_url     TEXT,
    current_bid   REAL NOT NULL,
    end_time      TEXT NOT NULL,
    estimated_resale REAL,
    confidence    TEXT,
    reasoning     TEXT,
    sources       TEXT,
    total_cost    REAL,
    profit        REAL,
    profit_pct    REAL,
    max_bid       REAL,
    status        TEXT NOT NULL DEFAULT 'active',
    model_mode    TEXT,
    scanned_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
CREATE INDEX IF NOT EXISTS idx_items_end_time ON items(end_time);
"""


def init(db_path: Path = DB_PATH) -> None:
    with sqlite3.connect(db_path) as conn:
        conn.executescript(SCHEMA)


@contextmanager
def connect(db_path: Path = DB_PATH):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def existing_ids(ids: Iterable[int]) -> set[int]:
    ids = list(ids)
    if not ids:
        return set()
    placeholders = ",".join("?" for _ in ids)
    with connect() as conn:
        rows = conn.execute(
            f"SELECT id FROM items WHERE id IN ({placeholders})", ids
        ).fetchall()
    return {r["id"] for r in rows}


def upsert_analyzed(
    *,
    item_id: int,
    title: str,
    url: str,
    image_url: str,
    current_bid: float,
    end_time: datetime,
    estimated_resale: float,
    confidence: str,
    reasoning: str,
    sources: list[str],
    total_cost: float,
    profit: float,
    profit_pct: float,
    max_bid: float,
    model_mode: str,
) -> None:
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO items (
                id, title, url, image_url, current_bid, end_time,
                estimated_resale, confidence, reasoning, sources,
                total_cost, profit, profit_pct, max_bid,
                status, model_mode, scanned_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
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
            """,
            (
                item_id,
                title,
                url,
                image_url,
                current_bid,
                end_time.isoformat(),
                estimated_resale,
                confidence,
                reasoning,
                json.dumps(sources),
                total_cost,
                profit,
                profit_pct,
                max_bid,
                model_mode,
                datetime.now(timezone.utc).isoformat(),
            ),
        )


def mark_expired_closed() -> int:
    now = datetime.now(timezone.utc).isoformat()
    with connect() as conn:
        cur = conn.execute(
            "UPDATE items SET status='closed' WHERE status='active' AND end_time < ?",
            (now,),
        )
        return cur.rowcount


def delete_closed() -> int:
    with connect() as conn:
        cur = conn.execute("DELETE FROM items WHERE status='closed'")
        return cur.rowcount


def get_all() -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM items ORDER BY status='closed', end_time ASC"
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["sources"] = json.loads(d["sources"]) if d["sources"] else []
        out.append(d)
    return out


def get_one(item_id: int) -> dict | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()
    if not row:
        return None
    d = dict(row)
    d["sources"] = json.loads(d["sources"]) if d["sources"] else []
    return d
