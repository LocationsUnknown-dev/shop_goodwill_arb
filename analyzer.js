// Claude-powered resale price estimator for Shop Goodwill gaming items.
//
// Two modes:
//   cheap     — Haiku 4.5, knowledge only. ~$0.002/item.
//   accurate  — Sonnet 4.6 + web search grounding. ~$0.03-0.05/item.

import Anthropic from "@anthropic-ai/sdk";

export const MODELS = {
  cheap: "claude-haiku-4-5",
  accurate: "claude-sonnet-4-6",
};

const SYSTEM_PROMPT = `\
You are a pricing analyst for a flipping operation. Given a single auction \
listing from Shop Goodwill's Gaming Systems category, estimate what the item \
could be resold for **to a game store trade-in counter** (GameStop, Disc \
Replay, 2nd & Charles, local independent game stores).

Important context:
- Trade-in values are typically **40-60% of eBay sold comps** — game stores \
need margin to resell.
- For bundles (console + controllers + games), value the whole lot; a working \
console with original controller and cords usually trades better than a bare \
console.
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
cite specific comps or pricing sources you used.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    estimated_resale: {
      type: "number",
      description: "Estimated trade-in value in USD (point estimate).",
    },
    confidence: {
      type: "string",
      enum: ["low", "medium", "high"],
      description: "How confident you are in the estimate.",
    },
    reasoning: {
      type: "string",
      description: "1-3 sentences explaining the estimate.",
    },
    sources: {
      type: "array",
      items: { type: "string" },
      description: "URLs or specific comps referenced (empty if none).",
    },
  },
  required: ["estimated_resale", "confidence", "reasoning", "sources"],
  additionalProperties: false,
};

let sharedClient = null;
function getClient() {
  if (!sharedClient) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY not set");
    }
    sharedClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return sharedClient;
}

function userMessage({ title, currentBid, imageUrl }) {
  const lines = [
    `Title: ${title}`,
    `Current high bid: $${currentBid.toFixed(2)}`,
  ];
  if (imageUrl) lines.push(`Listing image: ${imageUrl}`);
  lines.push("");
  lines.push(
    "Estimate the realistic game-store trade-in value for this lot. " +
      "Return a single point estimate in USD."
  );
  return [{ type: "text", text: lines.join("\n") }];
}

export async function estimate({ mode, title, currentBid, imageUrl = "" }) {
  const client = getClient();

  const params = {
    model: MODELS[mode],
    max_tokens: 1500,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userMessage({ title, currentBid, imageUrl }) }],
    output_config: {
      format: { type: "json_schema", schema: RESPONSE_SCHEMA },
    },
  };

  if (mode === "accurate") {
    params.tools = [
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 2,
      },
    ];
  }

  const response = await client.messages.create(params);

  // With web_search, narration text may precede the final schema-constrained
  // JSON. Try each text block; use the first that parses as the expected shape.
  let data = null;
  for (const block of response.content) {
    if (block.type !== "text") continue;
    try {
      const parsed = JSON.parse(block.text);
      if (parsed && typeof parsed === "object" && "estimated_resale" in parsed) {
        data = parsed;
        break;
      }
    } catch {
      // next block
    }
  }
  if (!data) throw new Error("Claude returned no parseable JSON response");

  return {
    estimatedResale: Number(data.estimated_resale),
    confidence: String(data.confidence),
    reasoning: String(data.reasoning),
    sources: (data.sources ?? []).map(String),
  };
}
