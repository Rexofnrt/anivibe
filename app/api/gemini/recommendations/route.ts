import { NextResponse } from "next/server";

import { SEED_CATALOG } from "@/lib/catalog";
import { fallbackRecommendations } from "@/lib/recommendation-engine";
import { RecommendationResponse, WatchSignal } from "@/lib/types";

interface RequestBody {
  history?: WatchSignal[];
  feedback?: Record<number, "like" | "dislike">;
}

const buildPrompt = (history: WatchSignal[]) => {
  const compactHistory = history.map((item) => ({
    title: item.title,
    status: item.status,
    rating: item.rating,
    genres: item.genres,
    tone: item.tone,
    popularity: item.popularity,
  }));

  return `You are AniVibe's recommendation engine.
Return ONLY valid JSON with this exact shape:
{
  "recommendations": [
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
- Return exactly 10 recommendations.
- Include at least 1 hidden gem (lower popularity / less mainstream).
- Reason must reference theme/tone patterns, not generic "because you watched X".
- Keep each reason under 35 words.

User watch history signals:
${JSON.stringify(compactHistory, null, 2)}
`;
};

const parseGeminiJson = (rawText: string) => {
  const cleaned = rawText.replace(/```json/gi, "").replace(/```/g, "").trim();
  return JSON.parse(cleaned) as {
    recommendations: Array<{
      title: string;
      reason: string;
      confidence: "High" | "Medium" | "Low";
      hiddenGem: boolean;
      genres: string[];
      tone: string[];
    }>;
  };
};

const mapGeminiOutput = (items: NonNullable<ReturnType<typeof parseGeminiJson>["recommendations"]>) => {
  const nextIdStart = 900_000;

  return items.map((item, index) => {
    const match = SEED_CATALOG.find(
      (anime) => anime.title.toLowerCase() === item.title.toLowerCase(),
    );

    return {
      id: match?.id ?? nextIdStart + index,
      title: item.title,
      reason: item.reason,
      confidence: item.confidence,
      hiddenGem: item.hiddenGem,
      genres: item.genres,
      tone: item.tone,
    };
  });
};

export async function POST(request: Request) {
  const startedAt = Date.now();

  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    body = {};
  }

  const history = body.history ?? [];
  const feedback = body.feedback ?? {};

  const fallbackPayload: RecommendationResponse = {
    source: "fallback",
    latencyMs: Date.now() - startedAt,
    items: fallbackRecommendations({ history, feedback, count: 10 }),
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
          contents: [{ role: "user", parts: [{ text: buildPrompt(history) }] }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.7,
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
    const mapped = mapGeminiOutput(parsed.recommendations ?? []);

    if (!mapped.length) {
      return NextResponse.json(fallbackPayload);
    }

    return NextResponse.json({
      source: "gemini",
      latencyMs: Date.now() - startedAt,
      items: mapped.slice(0, 10),
    } satisfies RecommendationResponse);
  } catch {
    clearTimeout(timeout);
    return NextResponse.json(fallbackPayload);
  }
}
