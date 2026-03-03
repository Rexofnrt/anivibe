import { NextResponse } from "next/server";

import { SEED_CATALOG } from "@/lib/catalog";
import { fallbackVibeRecommendations } from "@/lib/recommendation-engine";
import { VibeResponse, WatchSignal } from "@/lib/types";

interface RequestBody {
  query?: string;
  history?: WatchSignal[];
}

const buildFallbackPayload = ({
  startedAt,
  fallback,
  reason,
}: {
  startedAt: number;
  fallback: ReturnType<typeof fallbackVibeRecommendations>;
  reason: string;
}): VibeResponse => ({
  source: "fallback",
  latencyMs: Date.now() - startedAt,
  vibeSummary: fallback.vibeSummary,
  items: fallback.items,
  fallbackReason: reason,
});

const extractErrorMessage = async (response: Response) => {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string; status?: string };
    };
    return (
      parsed.error?.message ||
      parsed.error?.status ||
      `Gemini request failed with status ${response.status}`
    );
  } catch {
    return text || `Gemini request failed with status ${response.status}`;
  }
};

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

const clampTimeoutMs = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(60_000, Math.max(5_000, Math.floor(parsed)));
};

const GEMINI_TIMEOUT_MS = clampTimeoutMs(process.env.GEMINI_TIMEOUT_MS, 25_000);
const GEMINI_RETRY_TIMEOUT_MS = clampTimeoutMs(
  process.env.GEMINI_RETRY_TIMEOUT_MS,
  35_000,
);
const MAX_HISTORY_ITEMS = 30;

const requestGemini = async ({
  apiKey,
  prompt,
  timeoutMs,
}: {
  apiKey: string;
  prompt: string;
  timeoutMs: number;
}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.8,
          },
        }),
        signal: controller.signal,
      },
    );
  } finally {
    clearTimeout(timeout);
  }
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
  const historyForPrompt = history.slice(-MAX_HISTORY_ITEMS);

  if (!query) {
    return NextResponse.json(
      { error: "Vibe query is required." },
      { status: 400 },
    );
  }

  const fallback = fallbackVibeRecommendations({ query, history, count: 8 });
  const fallbackPayload = (reason: string) =>
    buildFallbackPayload({ startedAt, fallback, reason });

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json(
      fallbackPayload("Gemini API key not configured on the server."),
    );
  }

  try {
    const prompt = buildPrompt(query, historyForPrompt);

    let response: Response;
    try {
      response = await requestGemini({
        apiKey,
        prompt,
        timeoutMs: GEMINI_TIMEOUT_MS,
      });
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === "AbortError";
      if (!isTimeout) throw error;

      response = await requestGemini({
        apiKey,
        prompt,
        timeoutMs: GEMINI_RETRY_TIMEOUT_MS,
      });
    }

    if (!response.ok) {
      const errorMessage = await extractErrorMessage(response);
      return NextResponse.json(fallbackPayload(errorMessage));
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
      return NextResponse.json(
        fallbackPayload("Gemini returned an empty vibe response."),
      );
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
      return NextResponse.json(
        fallbackPayload("Gemini response did not contain usable vibe results."),
      );
    }

    return NextResponse.json({
      source: "gemini",
      latencyMs: Date.now() - startedAt,
      vibeSummary: parsed.vibeSummary,
      items: mapped.slice(0, 10),
    } satisfies VibeResponse);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.name === "AbortError"
          ? `Gemini request timed out after retry (${GEMINI_TIMEOUT_MS}ms + ${GEMINI_RETRY_TIMEOUT_MS}ms).`
          : error.message
        : "Gemini request failed or timed out.";
    return NextResponse.json(
      fallbackPayload(message),
    );
  }
}
