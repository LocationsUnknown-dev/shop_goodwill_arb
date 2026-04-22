"""Claude-powered resale price estimator for Shop Goodwill gaming items.

Two modes:
- ``cheap``  — Haiku 4.5, knowledge only. ~$0.002/item.
- ``accurate`` — Sonnet 4.6 + web search grounding. ~$0.03-0.05/item.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Literal

import anthropic

MODE = Literal["cheap", "accurate"]

MODELS = {
    "cheap": "claude-haiku-4-5",
    "accurate": "claude-sonnet-4-6",
}

SYSTEM_PROMPT = """\
You are a pricing analyst for a flipping operation. Given a single auction \
listing from Shop Goodwill's Gaming Systems category, estimate what the item \
could be resold for **to a game store trade-in counter** (GameStop, Disc \
Replay, 2nd & Charles, local independent game stores).

Important context:
- Trade-in values are typically **40-60% of eBay sold comps** — game stores \
need margin to resell.
- For bundles (console + controllers + games), value the whole lot; a working \
console with original controller and cords usually trades better than a \
bare console.
- "AS-IS" or "untested" listings get marked down 30-50% vs working condition \
because the buyer assumes repair risk.
- Missing power cables, AV cables, controllers, original packaging each knock \
10-25% off depending on the item.
- Retro/vintage systems (pre-2005) typically command stronger trade values \
than recent-gen consoles.
- Base your estimate on current realistic trade-in offers, not eBay retail or \
collector prices.

Return your answer as a conservative point estimate (in USD) of the trade-in \
value a typical game store would offer in cash/store credit. When available, \
cite specific comps or pricing sources you used.
"""

RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "estimated_resale": {
            "type": "number",
            "description": "Estimated trade-in value in USD (point estimate).",
        },
        "confidence": {
            "type": "string",
            "enum": ["low", "medium", "high"],
            "description": "How confident you are in the estimate.",
        },
        "reasoning": {
            "type": "string",
            "description": "1-3 sentences explaining the estimate.",
        },
        "sources": {
            "type": "array",
            "items": {"type": "string"},
            "description": "URLs or specific comps referenced (empty if none).",
        },
    },
    "required": ["estimated_resale", "confidence", "reasoning", "sources"],
    "additionalProperties": False,
}


@dataclass
class Estimate:
    estimated_resale: float
    confidence: str
    reasoning: str
    sources: list[str]


def _client() -> anthropic.AsyncAnthropic:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY not set")
    return anthropic.AsyncAnthropic(api_key=api_key)


def _user_message(*, title: str, current_bid: float, image_url: str) -> list[dict]:
    lines = [
        f"Title: {title}",
        f"Current high bid: ${current_bid:.2f}",
    ]
    if image_url:
        lines.append(f"Listing image: {image_url}")
    lines.append("")
    lines.append(
        "Estimate the realistic game-store trade-in value for this lot. "
        "Return a single point estimate in USD."
    )
    return [{"type": "text", "text": "\n".join(lines)}]


async def estimate(
    *,
    mode: MODE,
    title: str,
    current_bid: float,
    image_url: str = "",
    client: anthropic.AsyncAnthropic | None = None,
) -> Estimate:
    own_client = client is None
    if own_client:
        client = _client()

    kwargs: dict = {
        "model": MODELS[mode],
        "max_tokens": 1500,
        "system": [
            {
                "type": "text",
                "text": SYSTEM_PROMPT,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        "messages": [
            {"role": "user", "content": _user_message(
                title=title, current_bid=current_bid, image_url=image_url
            )}
        ],
        "output_config": {
            "format": {"type": "json_schema", "schema": RESPONSE_SCHEMA}
        },
    }

    if mode == "accurate":
        kwargs["tools"] = [
            {
                "type": "web_search_20250305",
                "name": "web_search",
                "max_uses": 2,
            }
        ]

    try:
        response = await client.messages.create(**kwargs)
    finally:
        if own_client:
            await client.close()

    # With web_search, there may be narration text blocks before the final
    # schema-constrained JSON. Try each text block; return the first that
    # parses as a dict with the expected key.
    data = None
    for block in response.content:
        if getattr(block, "type", None) != "text":
            continue
        try:
            parsed = json.loads(block.text)
        except (ValueError, AttributeError):
            continue
        if isinstance(parsed, dict) and "estimated_resale" in parsed:
            data = parsed
            break
    if data is None:
        raise RuntimeError("Claude returned no parseable JSON response")
    return Estimate(
        estimated_resale=float(data["estimated_resale"]),
        confidence=str(data["confidence"]),
        reasoning=str(data["reasoning"]),
        sources=[str(s) for s in data.get("sources", [])],
    )
