import { NextResponse } from "next/server";

import { SEED_CATALOG } from "@/lib/catalog";
import { fallbackRecommendations } from "@/lib/recommendation-engine";
import { RecommendationResponse, WatchSignal } from "@/lib/types";

interface RequestBody {
  history?: WatchSignal[];
  feedback?: Record<number, "like" | "dislike">;
}

const buildFallbackPayload = ({
  startedAt,
  history,
  feedback,
  reason,
}: {
  startedAt: number;
  history: WatchSignal[];
  feedback: Record<number, "like" | "dislike">;
  reason: string;
}): RecommendationResponse => ({
  source: "fallback",
  latencyMs: Date.now() - startedAt,
  items: fallbackRecommendations({ history, feedback, count: 10 }),
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
            temperature: 0.7,
          },
        }),
        signal: controller.signal,
      },
    );
  } finally {
    clearTimeout(timeout);
  }
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
  const historyForPrompt = history.slice(-MAX_HISTORY_ITEMS);

  const fallbackPayload = (reason: string) =>
    buildFallbackPayload({ startedAt, history, feedback, reason });

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json(
      fallbackPayload("Gemini API key not configured on the server."),
    );
  }

  try {
    const prompt = buildPrompt(historyForPrompt);

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
        fallbackPayload("Gemini returned an empty response."),
      );
    }

    const parsed = parseGeminiJson(rawText);
    const mapped = mapGeminiOutput(parsed.recommendations ?? []);

    if (!mapped.length) {
      return NextResponse.json(
        fallbackPayload("Gemini response did not contain usable recommendations."),
      );
    }

    return NextResponse.json({
      source: "gemini",
      latencyMs: Date.now() - startedAt,
      items: mapped.slice(0, 10),
    } satisfies RecommendationResponse);
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
