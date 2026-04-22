# Goodwill Gaming Deals Scanner

Lightweight local Node.js app that scans Shop Goodwill's Gaming Systems
category for auctions ending soon and uses Claude to estimate what a game
store would pay for each lot. Surfaces items where
`estimated_resale > current_bid + shipping`.

## Features

- **Hours slider (1–24h)** — scan only auctions ending within N hours
- **Two AI modes**:
  - **Cheap** — Claude Haiku 4.5, knowledge only (~$0.002/item)
  - **Accurate** — Claude Sonnet 4.6 + web search (~$0.03–0.05/item)
- **Minimum profit %** filter (client-side, no rescan needed)
- **Only-new scans** — subsequent scans skip items already in the DB
- **Per-row rescan** in either mode
- **Auto-closed auctions** with one-click cleanup
- **SQLite persistence** across restarts (via better-sqlite3)

## Setup

Requires Node.js 18 or newer.

```bash
npm install
cp .env.example .env
# edit .env: paste your ANTHROPIC_API_KEY
npm start
```

Then open <http://localhost:5000>.

Use `npm run dev` for auto-restart on file changes.

### Finding the right category ID

`SHOPGOODWILL_CAT_IDS` in `.env` defaults to `26`. If scans return zero or the
wrong items:

1. Open <https://shopgoodwill.com/categories/gaming-systems> in Chrome
2. Open DevTools → Network, filter by `ItemListing`
3. Refresh the page, click the request, and copy the `catIds` value from the
   request body into `.env`
4. Restart `npm start`

## Cost reference

Per full scan (slider at 24h, roughly 80 auctions):

| Mode                    | Approx. cost |
| ----------------------- | ------------ |
| Cheap (Haiku 4.5)       | ~$0.20       |
| Accurate (Sonnet + web) | ~$4          |

Per individual rescan: ~$0.002 cheap / ~$0.05 accurate.

Drop the slider (e.g. to 6h) to scan fewer items. The "only-new" rescan logic
means repeated full scans during the same day do almost no additional work.

## Files

- `server.js` — Express app + routes
- `goodwill.js` — Shop Goodwill API client (`fetch`-based)
- `analyzer.js` — Claude estimator (cheap + accurate modes)
- `db.js` — better-sqlite3 schema + queries
- `public/index.html`, `public/app.js`, `public/style.css` — UI
