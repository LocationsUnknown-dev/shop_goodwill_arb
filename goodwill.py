"""Shop Goodwill listings fetcher.

Hits the public buyer API that backs https://shopgoodwill.com and returns
auctions ending within the next ``max_hours`` hours, sorted end-time ascending.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterator

import httpx

API_URL = "https://buyerapi.shopgoodwill.com/api/Search/ItemListing"
LISTING_URL_FMT = "https://shopgoodwill.com/item/{item_id}"
PAGE_SIZE = 40
# sortColumn "1" = end time ascending (soonest first) in the buyer API.
SORT_END_TIME_ASC = "1"

HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "Origin": "https://shopgoodwill.com",
    "Referer": "https://shopgoodwill.com/",
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
}


@dataclass
class Listing:
    item_id: int
    title: str
    current_bid: float
    num_bids: int
    end_time: datetime  # UTC
    image_url: str
    item_url: str

    def to_dict(self) -> dict:
        return {
            "item_id": self.item_id,
            "title": self.title,
            "current_bid": self.current_bid,
            "num_bids": self.num_bids,
            "end_time": self.end_time.isoformat(),
            "image_url": self.image_url,
            "item_url": self.item_url,
        }


def _build_payload(cat_ids: str, page: int) -> dict:
    return {
        "isSize": False,
        "isWeddingCategory": "false",
        "isMultipleCategoryIds": False,
        "isFromHeaderMenuTab": False,
        "layout": "",
        "searchText": "",
        "selectedGroup": "",
        "selectedCategoryIds": "",
        "selectedSellerIds": "",
        "lowPrice": "0",
        "highPrice": "999999",
        "searchBuyNowOnly": "",
        "searchPickupOnly": "false",
        "searchNoPickupOnly": "false",
        "searchDescriptions": "false",
        "searchClosedAuctions": "false",
        "closedAuctionEndingDate": "1/1/1",
        "closedAuctionDaysBack": "7",
        "savedSearchId": 0,
        "sortColumn": SORT_END_TIME_ASC,
        "page": page,
        "pageSize": PAGE_SIZE,
        "sortDescending": "false",
        "savedSearchName": "",
        "useBuyerPrefs": "false",
        "catIds": cat_ids,
    }


def _parse_end_time(raw: str) -> datetime:
    # API returns strings like "2026-04-22T18:30:00" (no timezone) in US/Pacific.
    # Shop Goodwill's server timezone is Pacific. We treat naive timestamps as
    # UTC-ish for sorting purposes; absolute accuracy matters less than
    # ordering. For correctness we convert assuming the string is UTC — the
    # user-facing "ends in" is computed as a delta either way.
    if raw.endswith("Z"):
        raw = raw[:-1]
    # Strip fractional seconds if present.
    if "." in raw:
        raw = raw.split(".", 1)[0]
    dt = datetime.fromisoformat(raw)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _parse_listings(raw: dict) -> Iterator[Listing]:
    for item in raw.get("searchResults", {}).get("items", []) or []:
        try:
            item_id = int(item["itemId"])
            yield Listing(
                item_id=item_id,
                title=item.get("title", "").strip(),
                current_bid=float(item.get("minimumBid") or item.get("currentPrice") or 0),
                num_bids=int(item.get("numBids") or 0),
                end_time=_parse_end_time(item["endTime"]),
                image_url=item.get("imageURL") or item.get("imageUrl") or "",
                item_url=LISTING_URL_FMT.format(item_id=item_id),
            )
        except (KeyError, ValueError, TypeError):
            continue


async def fetch_ending_soon(
    cat_ids: str,
    max_hours: int,
    *,
    client: httpx.AsyncClient | None = None,
    page_delay: float = 0.3,
) -> list[Listing]:
    """Page through listings (sorted end-time asc) until we pass max_hours.

    Returns all listings ending within ``max_hours`` from now.
    """
    now = datetime.now(timezone.utc)
    cutoff = now.timestamp() + max_hours * 3600

    own_client = client is None
    if own_client:
        client = httpx.AsyncClient(headers=HEADERS, timeout=20.0)

    results: list[Listing] = []
    try:
        page = 1
        while True:
            resp = await client.post(API_URL, json=_build_payload(cat_ids, page))
            resp.raise_for_status()
            data = resp.json()
            page_items = list(_parse_listings(data))
            if not page_items:
                break

            stop = False
            for listing in page_items:
                if listing.end_time.timestamp() > cutoff:
                    stop = True
                    break
                results.append(listing)
            if stop:
                break

            total_pages = data.get("searchResults", {}).get("totalPages")
            if total_pages and page >= int(total_pages):
                break
            page += 1
            await asyncio.sleep(page_delay)
    finally:
        if own_client:
            await client.aclose()

    return results
