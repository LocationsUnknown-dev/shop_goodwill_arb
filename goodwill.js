// Shop Goodwill listings fetcher.
// Hits the public buyer API that backs https://shopgoodwill.com and returns
// auctions ending within the next `maxHours` hours, sorted end-time ascending.

const API_URL = "https://buyerapi.shopgoodwill.com/api/Search/ItemListing";
const LISTING_URL = (id) => `https://shopgoodwill.com/item/${id}`;
const PAGE_SIZE = 40;
// sortColumn "1" = end time ascending in the buyer API.
const SORT_END_TIME_ASC = "1";

export const HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Content-Type": "application/json",
  Origin: "https://shopgoodwill.com",
  Referer: "https://shopgoodwill.com/",
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

function buildPayload(catIds, page) {
  return {
    isSize: false,
    isWeddingCategory: "false",
    isMultipleCategoryIds: false,
    isFromHeaderMenuTab: false,
    layout: "",
    searchText: "",
    selectedGroup: "",
    selectedCategoryIds: "",
    selectedSellerIds: "",
    lowPrice: "0",
    highPrice: "999999",
    searchBuyNowOnly: "",
    searchPickupOnly: "false",
    searchNoPickupOnly: "false",
    searchDescriptions: "false",
    searchClosedAuctions: "false",
    closedAuctionEndingDate: "1/1/1",
    closedAuctionDaysBack: "7",
    savedSearchId: 0,
    sortColumn: SORT_END_TIME_ASC,
    page,
    pageSize: PAGE_SIZE,
    sortDescending: "false",
    savedSearchName: "",
    useBuyerPrefs: "false",
    catIds,
  };
}

function parseEndTime(raw) {
  // API returns strings like "2026-04-22T18:30:00" (no timezone). We treat
  // naive timestamps as UTC — absolute timezone accuracy matters less than
  // ordering; "ends in" is computed as a delta in the UI.
  let s = raw;
  if (s.endsWith("Z")) s = s.slice(0, -1);
  if (s.includes(".")) s = s.split(".", 1)[0];
  // Ensure Date treats it as UTC.
  const d = new Date(s + "Z");
  if (isNaN(d.getTime())) throw new Error(`bad endTime: ${raw}`);
  return d;
}

function parseListings(raw) {
  const items = raw?.searchResults?.items ?? [];
  const out = [];
  for (const item of items) {
    try {
      const itemId = Number(item.itemId);
      if (!Number.isFinite(itemId)) continue;
      out.push({
        itemId,
        title: (item.title ?? "").trim(),
        currentBid: Number(item.minimumBid ?? item.currentPrice ?? 0),
        numBids: Number(item.numBids ?? 0),
        endTime: parseEndTime(item.endTime),
        imageUrl: item.imageURL ?? item.imageUrl ?? "",
        itemUrl: LISTING_URL(itemId),
      });
    } catch {
      // Skip malformed rows.
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function fetchEndingSoon(catIds, maxHours, { pageDelayMs = 300 } = {}) {
  const cutoffMs = Date.now() + maxHours * 3600 * 1000;
  const results = [];
  let page = 1;
  while (true) {
    const resp = await fetch(API_URL, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify(buildPayload(catIds, page)),
    });
    if (!resp.ok) {
      throw new Error(`Shop Goodwill API returned ${resp.status}: ${await resp.text().catch(() => "")}`);
    }
    const data = await resp.json();
    const pageItems = parseListings(data);
    if (pageItems.length === 0) break;

    let stop = false;
    for (const listing of pageItems) {
      if (listing.endTime.getTime() > cutoffMs) {
        stop = true;
        break;
      }
      results.push(listing);
    }
    if (stop) break;

    const totalPages = Number(data?.searchResults?.totalPages ?? 0);
    if (totalPages && page >= totalPages) break;
    page += 1;
    await sleep(pageDelayMs);
  }
  return results;
}
