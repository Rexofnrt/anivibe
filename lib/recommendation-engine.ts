import { SEED_CATALOG } from "@/lib/catalog";
import { RecommendationItem, WatchSignal } from "@/lib/types";

const clampCount = (count: number, min = 1, max = 10) => Math.min(max, Math.max(min, count));

const tokenize = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

const inferPreferredGenres = (history: WatchSignal[]) => {
  const scores = new Map<string, number>();
  for (const item of history) {
    const weight = item.rating ? item.rating / 2 : item.status === "Completed" ? 3 : 1;
    for (const genre of item.genres) {
      scores.set(genre, (scores.get(genre) ?? 0) + weight);
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([genre]) => genre);
};

const inferPreferredTones = (history: WatchSignal[]) => {
  const scores = new Map<string, number>();
  for (const item of history) {
    const weight = item.rating ? Math.max(1, item.rating / 2) : 1;
    for (const tone of item.tone) {
      scores.set(tone, (scores.get(tone) ?? 0) + weight);
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tone]) => tone);
};

const matchScore = (candidate: { genres: string[]; tone: string[]; popularity: number }, preferredGenres: string[], preferredTones: string[], dislikeTokens: string[]) => {
  let score = 0;

  score += candidate.genres.filter((genre) => preferredGenres.includes(genre)).length * 2.5;
  score += candidate.tone.filter((tone) => preferredTones.includes(tone)).length * 2;
  score += candidate.popularity < 60 ? 1.5 : 0.5;

  const candidateTokens = [...candidate.genres, ...candidate.tone].flatMap(tokenize);
  if (candidateTokens.some((token) => dislikeTokens.includes(token))) {
    score -= 3;
  }

  return score;
};

export const fallbackRecommendations = ({
  history,
  feedback,
  count = 10,
}: {
  history: WatchSignal[];
  feedback: Record<number, "like" | "dislike">;
  count?: number;
}): RecommendationItem[] => {
  const preferredGenres = inferPreferredGenres(history);
  const preferredTones = inferPreferredTones(history);
  const watchedTitles = new Set(history.map((item) => item.title.toLowerCase()));

  const dislikeTokens = Object.entries(feedback)
    .filter(([, vote]) => vote === "dislike")
    .flatMap(([id]) => {
      const anime = SEED_CATALOG.find((entry) => entry.id === Number(id));
      if (!anime) return [];
      return [...anime.genres, ...anime.tone].flatMap(tokenize);
    });

  const sorted = [...SEED_CATALOG]
    .filter((anime) => !watchedTitles.has(anime.title.toLowerCase()))
    .map((anime) => ({
      anime,
      score: matchScore(anime, preferredGenres, preferredTones, dislikeTokens),
    }))
    .sort((a, b) => b.score - a.score);

  const targetCount = clampCount(count, 5, 10);
  const picks = sorted.slice(0, targetCount).map(({ anime }, index) => ({
    id: anime.id,
    title: anime.title,
    genres: anime.genres,
    tone: anime.tone,
    hiddenGem: anime.popularity < 60,
    confidence: index < 3 ? "High" : index < 7 ? "Medium" : "Low",
    reason: `Matches your ${preferredGenres.slice(0, 2).join(" + ")} preferences with a ${anime.tone[0].toLowerCase()} tone and ${anime.complexity >= 8 ? "high" : "balanced"} narrative complexity.`,
  })) as RecommendationItem[];

  if (!picks.some((pick) => pick.hiddenGem)) {
    const hiddenGem = sorted.find(({ anime }) => anime.popularity < 60);
    if (hiddenGem) {
      picks[picks.length - 1] = {
        id: hiddenGem.anime.id,
        title: hiddenGem.anime.title,
        genres: hiddenGem.anime.genres,
        tone: hiddenGem.anime.tone,
        hiddenGem: true,
        confidence: "Medium",
        reason: "Hidden gem match selected for your profile: lower mainstream popularity but strong thematic overlap with your recent favorites.",
      };
    }
  }

  return picks;
};

const vibeMap: Record<string, string[]> = {
  sad: ["Sad", "Melancholic", "Bittersweet", "Reflective", "Emotional"],
  beautiful: ["Ethereal", "Reflective", "Wholesome"],
  high: ["High-energy", "Intense", "Competitive"],
  tournament: ["Sports", "Action", "Competitive"],
  psychological: ["Psychological", "Mind-bending", "Noir"],
  dark: ["Dark", "Bleak", "Psychological"],
  wholesome: ["Wholesome", "Warm", "Soothing"],
  revenge: ["Brutal", "Dark", "Intense"],
};

export const fallbackVibeRecommendations = ({
  query,
  history,
  count = 8,
}: {
  query: string;
  history: WatchSignal[];
  count?: number;
}) => {
  const queryTokens = tokenize(query);
  const preferredGenres = inferPreferredGenres(history);
  const targetTones = queryTokens.flatMap((token) => vibeMap[token] ?? []);
  const watchedTitles = new Set(history.map((item) => item.title.toLowerCase()));

  const scored = [...SEED_CATALOG]
    .filter((anime) => !watchedTitles.has(anime.title.toLowerCase()))
    .map((anime) => {
      const toneScore = anime.tone.filter((tone) => targetTones.includes(tone)).length * 3;
      const genreScore = anime.genres.filter((genre) => preferredGenres.includes(genre)).length * 1.5;
      const tokenScore = tokenize(anime.synopsis).filter((token) => queryTokens.includes(token)).length;
      return {
        anime,
        score: toneScore + genreScore + tokenScore + (anime.popularity < 60 ? 0.5 : 0),
      };
    })
    .sort((a, b) => b.score - a.score);

  const items = scored.slice(0, clampCount(count, 5, 10)).map(({ anime }, index) => ({
    id: anime.id,
    title: anime.title,
    genres: anime.genres,
    tone: anime.tone,
    hiddenGem: anime.popularity < 60,
    confidence: index < 3 ? "High" : "Medium",
    reason: `Fits your vibe request with ${anime.tone.slice(0, 2).join(" / ")} energy and ${anime.genres[0]}-leaning storytelling.`,
  })) as RecommendationItem[];

  return {
    vibeSummary: targetTones.length
      ? `Vibe focus: ${targetTones.slice(0, 4).join(", ")} with profile-aware genre weighting.`
      : "Vibe focus: balanced match using your profile history and tone overlap.",
    items,
  };
};
