// Express app serving the Goodwill gaming deals scanner UI.

import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

import * as db from "./db.js";
import { fetchEndingSoon } from "./goodwill.js";
import { estimate } from "./analyzer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SHIPPING_COST = Number(process.env.SHIPPING_COST ?? 20);
const CAT_IDS = process.env.SHOPGOODWILL_CAT_IDS ?? "26";
const PORT = Number(process.env.PORT ?? 5000);
const CONCURRENCY = 3;

function computeFields(currentBid, estimatedResale) {
  const totalCost = currentBid + SHIPPING_COST;
  const profit = estimatedResale - totalCost;
  const profitPct = totalCost > 0 ? (profit / totalCost) * 100 : 0;
  const maxBid = Math.max(0, estimatedResale - SHIPPING_COST);
  return {
    totalCost: round2(totalCost),
    profit: round2(profit),
    profitPct: round2(profitPct),
    maxBid: round2(maxBid),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Minimal semaphore-backed map: run `fn(item)` for every item, at most N at a time.
async function mapWithLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i]);
      } catch (err) {
        results[i] = { error: err };
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

async function analyzeOne(listing, mode) {
  const est = await estimate({
    mode,
    title: listing.title,
    currentBid: listing.currentBid,
    imageUrl: listing.imageUrl,
  });
  const derived = computeFields(listing.currentBid, est.estimatedResale);
  db.upsertAnalyzed({
    itemId: listing.itemId,
    title: listing.title,
    url: listing.itemUrl,
    imageUrl: listing.imageUrl,
    currentBid: listing.currentBid,
    endTime: listing.endTime,
    estimatedResale: est.estimatedResale,
    confidence: est.confidence,
    reasoning: est.reasoning,
    sources: est.sources,
    ...derived,
    modelMode: mode,
  });
}

async function runScan({ maxHours, mode }) {
  db.markExpiredClosed();

  const listings = await fetchEndingSoon(CAT_IDS, maxHours);
  const seen = db.existingIds(listings.map((l) => l.itemId));
  const toAnalyze = listings.filter((l) => !seen.has(l.itemId));

  if (toAnalyze.length === 0) {
    return { fetched: listings.length, analyzed: 0, skipped: seen.size };
  }

  const outcomes = await mapWithLimit(toAnalyze, CONCURRENCY, (l) =>
    analyzeOne(l, mode)
  );
  const errors = outcomes.filter((o) => o && o.error).length;
  return {
    fetched: listings.length,
    analyzed: toAnalyze.length - errors,
    skipped: seen.size,
    errors,
  };
}

async function rescanOne(itemId, mode) {
  const existing = db.getOne(itemId);
  if (!existing) return null;
  const est = await estimate({
    mode,
    title: existing.title,
    currentBid: existing.current_bid,
    imageUrl: existing.image_url ?? "",
  });
  const derived = computeFields(existing.current_bid, est.estimatedResale);
  db.upsertAnalyzed({
    itemId,
    title: existing.title,
    url: existing.url,
    imageUrl: existing.image_url ?? "",
    currentBid: existing.current_bid,
    endTime: existing.end_time,
    estimatedResale: est.estimatedResale,
    confidence: est.confidence,
    reasoning: est.reasoning,
    sources: est.sources,
    ...derived,
    modelMode: mode,
  });
  return db.getOne(itemId);
}

const app = express();
app.use(express.json());
app.use("/static", express.static(path.join(__dirname, "public")));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/api/items", (_req, res) => {
  db.markExpiredClosed();
  res.json(db.getAll());
});

app.post("/api/scan", async (req, res) => {
  const maxHours = Math.max(1, Math.min(24, Number(req.body?.max_hours ?? 24)));
  const mode = req.body?.mode ?? "cheap";
  if (mode !== "cheap" && mode !== "accurate") {
    return res.status(400).json({ error: "invalid mode" });
  }
  try {
    const summary = await runScan({ maxHours, mode });
    res.json({ ...summary, items: db.getAll() });
  } catch (err) {
    console.error("Scan failed:", err);
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

app.post("/api/scan/:id", async (req, res) => {
  const itemId = Number(req.params.id);
  if (!Number.isFinite(itemId)) {
    return res.status(400).json({ error: "invalid id" });
  }
  const mode = req.body?.mode ?? "cheap";
  if (mode !== "cheap" && mode !== "accurate") {
    return res.status(400).json({ error: "invalid mode" });
  }
  try {
    const updated = await rescanOne(itemId, mode);
    if (!updated) return res.status(404).json({ error: "item not found" });
    res.json(updated);
  } catch (err) {
    console.error("Rescan failed:", err);
    res.status(500).json({ error: String(err.message ?? err) });
  }
});

app.post("/api/clear-closed", (_req, res) => {
  const deleted = db.deleteClosed();
  res.json({ deleted, items: db.getAll() });
});

app.get("/api/config", (_req, res) => {
  res.json({ shippingCost: SHIPPING_COST });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Goodwill scanner running at http://localhost:${PORT}`);
});
