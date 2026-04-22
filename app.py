"""Flask app serving the Goodwill gaming deals scanner UI."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

import anthropic
import httpx
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request

import analyzer
import db
import goodwill

load_dotenv()

SHIPPING_COST = float(os.environ.get("SHIPPING_COST", "20"))
CAT_IDS = os.environ.get("SHOPGOODWILL_CAT_IDS", "26")
CONCURRENCY = 3

app = Flask(__name__)
db.init()


def _compute_fields(*, current_bid: float, estimated_resale: float) -> dict:
    total_cost = current_bid + SHIPPING_COST
    profit = estimated_resale - total_cost
    profit_pct = (profit / total_cost * 100) if total_cost > 0 else 0.0
    max_bid = max(0.0, estimated_resale - SHIPPING_COST)
    return {
        "total_cost": round(total_cost, 2),
        "profit": round(profit, 2),
        "profit_pct": round(profit_pct, 2),
        "max_bid": round(max_bid, 2),
    }


async def _analyze_listing(
    listing: goodwill.Listing,
    mode: analyzer.MODE,
    sem: asyncio.Semaphore,
    client: object,
) -> None:
    async with sem:
        try:
            est = await analyzer.estimate(
                mode=mode,
                title=listing.title,
                current_bid=listing.current_bid,
                image_url=listing.image_url,
                client=client,
            )
        except Exception as e:
            app.logger.exception("Analysis failed for %s: %s", listing.item_id, e)
            return

        derived = _compute_fields(
            current_bid=listing.current_bid,
            estimated_resale=est.estimated_resale,
        )
        db.upsert_analyzed(
            item_id=listing.item_id,
            title=listing.title,
            url=listing.item_url,
            image_url=listing.image_url,
            current_bid=listing.current_bid,
            end_time=listing.end_time,
            estimated_resale=est.estimated_resale,
            confidence=est.confidence,
            reasoning=est.reasoning,
            sources=est.sources,
            **derived,
            model_mode=mode,
        )


async def _scan(max_hours: int, mode: analyzer.MODE) -> dict:
    db.mark_expired_closed()

    async with httpx.AsyncClient(headers=goodwill.HEADERS, timeout=20.0) as http:
        listings = await goodwill.fetch_ending_soon(
            CAT_IDS, max_hours, client=http
        )

    seen = db.existing_ids(l.item_id for l in listings)
    to_analyze = [l for l in listings if l.item_id not in seen]

    if not to_analyze:
        return {"fetched": len(listings), "analyzed": 0, "skipped": len(seen)}

    client = anthropic.AsyncAnthropic()
    sem = asyncio.Semaphore(CONCURRENCY)
    try:
        await asyncio.gather(
            *(_analyze_listing(l, mode, sem, client) for l in to_analyze)
        )
    finally:
        await client.close()

    return {
        "fetched": len(listings),
        "analyzed": len(to_analyze),
        "skipped": len(seen),
    }


async def _rescan_one(item_id: int, mode: analyzer.MODE) -> dict | None:
    existing = db.get_one(item_id)
    if not existing:
        return None

    est = await analyzer.estimate(
        mode=mode,
        title=existing["title"],
        current_bid=existing["current_bid"],
        image_url=existing["image_url"] or "",
    )
    derived = _compute_fields(
        current_bid=existing["current_bid"],
        estimated_resale=est.estimated_resale,
    )
    from datetime import datetime
    db.upsert_analyzed(
        item_id=item_id,
        title=existing["title"],
        url=existing["url"],
        image_url=existing["image_url"] or "",
        current_bid=existing["current_bid"],
        end_time=datetime.fromisoformat(existing["end_time"]),
        estimated_resale=est.estimated_resale,
        confidence=est.confidence,
        reasoning=est.reasoning,
        sources=est.sources,
        **derived,
        model_mode=mode,
    )
    return db.get_one(item_id)


@app.route("/")
def index():
    return render_template("index.html", shipping_cost=SHIPPING_COST)


@app.route("/api/items")
def api_items():
    db.mark_expired_closed()
    return jsonify(db.get_all())


@app.route("/api/scan", methods=["POST"])
def api_scan():
    payload = request.get_json(silent=True) or {}
    max_hours = max(1, min(24, int(payload.get("max_hours", 24))))
    mode: analyzer.MODE = payload.get("mode", "cheap")
    if mode not in ("cheap", "accurate"):
        return jsonify({"error": "invalid mode"}), 400

    try:
        result = asyncio.run(_scan(max_hours, mode))
    except Exception as e:
        app.logger.exception("Scan failed")
        return jsonify({"error": str(e)}), 500

    result["items"] = db.get_all()
    return jsonify(result)


@app.route("/api/scan/<int:item_id>", methods=["POST"])
def api_rescan_one(item_id: int):
    payload = request.get_json(silent=True) or {}
    mode: analyzer.MODE = payload.get("mode", "cheap")
    if mode not in ("cheap", "accurate"):
        return jsonify({"error": "invalid mode"}), 400

    try:
        updated = asyncio.run(_rescan_one(item_id, mode))
    except Exception as e:
        app.logger.exception("Rescan failed")
        return jsonify({"error": str(e)}), 500

    if not updated:
        return jsonify({"error": "item not found"}), 404
    return jsonify(updated)


@app.route("/api/clear-closed", methods=["POST"])
def api_clear_closed():
    deleted = db.delete_closed()
    return jsonify({"deleted": deleted, "items": db.get_all()})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="127.0.0.1", port=port, debug=False)
