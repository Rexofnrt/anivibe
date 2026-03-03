export const WATCH_STATUSES = [
  "Watching",
  "Completed",
  "On-Hold",
  "Plan-to-Watch",
] as const;

export type WatchStatus = (typeof WATCH_STATUSES)[number];

export type FeedbackVote = "like" | "dislike";

export interface CatalogAnime {
  id: number;
  title: string;
  genres: string[];
  tone: string[];
  synopsis: string;
  episodes: number;
  popularity: number;
  complexity: number;
  morality: number;
  emotionalIntensity: number;
  posterGradient: string;
  posterImageUrl?: string;
}

export interface WatchEntry {
  animeId: number;
  status: WatchStatus;
  progress: number;
  rating: number | null;
  review: string;
}

export interface WatchSignal {
  title: string;
  status: WatchStatus;
  rating: number | null;
  genres: string[];
  tone: string[];
  popularity: number;
  complexity: number;
  morality: number;
  emotionalIntensity: number;
}

export interface RecommendationItem {
  id: number;
  title: string;
  reason: string;
  hiddenGem: boolean;
  confidence: "High" | "Medium" | "Low";
  genres: string[];
  tone: string[];
}

export interface RecommendationResponse {
  source: "gemini" | "fallback";
  latencyMs: number;
  items: RecommendationItem[];
  fallbackReason?: string;
}

export interface VibeResponse {
  source: "gemini" | "fallback";
  latencyMs: number;
  vibeSummary: string;
  items: RecommendationItem[];
  fallbackReason?: string;
}
