import { NextResponse } from "next/server";

import { SEED_CATALOG } from "@/lib/catalog";
import { fallbackVibeRecommendations } from "@/lib/recommendation-engine";
import { VibeResponse, WatchSignal } from "@/lib/types";

interface RequestBody {
  query?: string;
  history?: WatchSignal[];
}

const buildPrompt = (query: string, history: WatchSignal[]) => {
  const compactHistory = history.map((item) => ({
    title: item.title,
    genres: item.genres,
    tone: item.tone,
    rating: item.rating,
    status: item.status,
  }));

  return `You are AniVibe's Vibe Mode recommender.
User query: "${query}"
User history context:
${JSON.stringify(compactHistory, null, 2)}

Return ONLY valid JSON with exact shape:
{
  "vibeSummary": "string",
  "results": [
    {
      "title": "string",
      "reason": "string",
      "confidence": "High|Medium|Low",
      "hiddenGem": true,
      "genres": ["string"],
      "tone": ["string"]
    }
  ]
}

Rules:
- Return 5 to 10 results.
- Handle comparative constraints (e.g. less action, more psychological).
- Add at least one hidden gem.
- Reasons must mention the interpreted vibe.
`;
};

const parseGeminiJson = (rawText: string) => {
  const cleaned = rawText.replace(/```json/gi, "").replace(/```/g, "").trim();
  return JSON.parse(cleaned) as {
    vibeSummary: string;
    results: Array<{
      title: string;
      reason: string;
      confidence: "High" | "Medium" | "Low";
      hiddenGem: boolean;
      genres: string[];
      tone: string[];
    }>;
  };
};

export async function POST(request: Request) {
  const startedAt = Date.now();

  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    body = {};
  }

  const query = body.query?.trim() ?? "";
  const history = body.history ?? [];

  if (!query) {
    return NextResponse.json(
      { error: "Vibe query is required." },
      { status: 400 },
    );
  }

  const fallback = fallbackVibeRecommendations({ query, history, count: 8 });
  const fallbackPayload: VibeResponse = {
    source: "fallback",
    latencyMs: Date.now() - startedAt,
    vibeSummary: fallback.vibeSummary,
    items: fallback.items,
  };

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(fallbackPayload);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_500);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: buildPrompt(query, history) }] }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.8,
          },
        }),
        signal: controller.signal,
      },
    );

    clearTimeout(timeout);

    if (!response.ok) {
      return NextResponse.json(fallbackPayload);
    }

    const payload = (await response.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
    };

    const rawText =
      payload.candidates?.[0]?.content?.parts
        ?.map((part) => part.text ?? "")
        .join("\n") ?? "";

    if (!rawText) {
      return NextResponse.json(fallbackPayload);
    }

    const parsed = parseGeminiJson(rawText);

    const mapped = (parsed.results ?? []).map((item, index) => {
      const match = SEED_CATALOG.find(
        (anime) => anime.title.toLowerCase() === item.title.toLowerCase(),
      );
      return {
        id: match?.id ?? 950_000 + index,
        title: item.title,
        reason: item.reason,
        confidence: item.confidence,
        hiddenGem: item.hiddenGem,
        genres: item.genres,
        tone: item.tone,
      };
    });

    if (!mapped.length) {
      return NextResponse.json(fallbackPayload);
    }

    return NextResponse.json({
      source: "gemini",
      latencyMs: Date.now() - startedAt,
      vibeSummary: parsed.vibeSummary,
      items: mapped.slice(0, 10),
    } satisfies VibeResponse);
  } catch {
    clearTimeout(timeout);
    return NextResponse.json(fallbackPayload);
  }
}
