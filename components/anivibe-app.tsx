"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3,
  Compass,
  Heart,
  Search,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Tv,
  WandSparkles,
} from "lucide-react";
import {
  Cell,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";

import { DEFAULT_WATCHLIST, SEED_CATALOG } from "@/lib/catalog";
import {
  CatalogAnime,
  FeedbackVote,
  RecommendationItem,
  RecommendationResponse,
  VibeResponse,
  WATCH_STATUSES,
  WatchEntry,
  WatchSignal,
  WatchStatus,
} from "@/lib/types";
import anivibeLogo from "@/app/logo.jpeg";

type TabId = "tracker" | "discover" | "vibe" | "taste";

interface AniListSearchResult {
  id: number;
  title: string;
  genres: string[];
  episodes: number;
  synopsis: string;
  popularity: number;
  posterColor: string;
  posterImageUrl: string | null;
}

interface PersistedState {
  catalog: CatalogAnime[];
  watchlist: WatchEntry[];
  feedback: Record<number, FeedbackVote>;
}

interface PosterLookupResult {
  posterImageUrl: string | null;
  posterColor: string;
}

const STORAGE_KEY = "anivibe-state-v1";
const WATCHLIST_PAGE_SIZE = 2;
const SEARCH_RESULTS_PAGE_SIZE = 9;

const tabs: Array<{ id: TabId; label: string; icon: React.ReactNode }> = [
  { id: "tracker", label: "Tracker", icon: <Tv size={16} /> },
  { id: "discover", label: "Discover", icon: <Compass size={16} /> },
  { id: "vibe", label: "Vibe Mode", icon: <WandSparkles size={16} /> },
  { id: "taste", label: "My Taste", icon: <BarChart3 size={16} /> },
];

const posterGradients = [
  "linear-gradient(160deg, #1A1F2C 0%, #7B5EFF 100%)",
  "linear-gradient(160deg, #1A1F2C 0%, #FF458A 100%)",
  "linear-gradient(160deg, #0F172A 0%, #2563EB 100%)",
  "linear-gradient(160deg, #111827 0%, #16A34A 100%)",
  "linear-gradient(160deg, #111827 0%, #B45309 100%)",
];

const toneBuckets = ["Dark", "Emotional", "Wholesome", "High-energy"] as const;
type ToneBucket = (typeof toneBuckets)[number];

const toneBucketRules: Array<{ bucket: ToneBucket; keywords: string[] }> = [
  {
    bucket: "Dark",
    keywords: ["dark", "bleak", "noir", "grim", "brutal", "revenge", "horror"],
  },
  {
    bucket: "Emotional",
    keywords: [
      "emotional",
      "reflective",
      "melanch",
      "bittersweet",
      "sad",
      "heartfelt",
      "character-driven",
      "romantic",
      "romance",
      "healing",
    ],
  },
  {
    bucket: "Wholesome",
    keywords: ["wholesome", "warm", "soothing", "hopeful", "cozy", "motivational"],
  },
  {
    bucket: "High-energy",
    keywords: ["high-energy", "energetic", "intense", "chaotic", "competitive", "aggressive"],
  },
];

const genreToneFallbackRules: Array<{ bucket: ToneBucket; keywords: string[] }> = [
  { bucket: "Dark", keywords: ["psychological", "crime", "thriller", "mystery", "horror"] },
  { bucket: "Emotional", keywords: ["romance", "drama"] },
  { bucket: "Wholesome", keywords: ["slice of life", "comedy"] },
  { bucket: "High-energy", keywords: ["action", "sports"] },
];

const genreMetricRules: Array<{
  keywords: string[];
  complexity: number;
  morality: number;
  emotionalIntensity: number;
}> = [
  { keywords: ["romance"], complexity: -0.4, morality: -0.3, emotionalIntensity: 1.2 },
  { keywords: ["drama"], complexity: 0.4, morality: 0.2, emotionalIntensity: 0.9 },
  { keywords: ["slice of life"], complexity: -0.8, morality: -0.5, emotionalIntensity: 0.5 },
  { keywords: ["action", "sports"], complexity: -0.2, morality: 0.1, emotionalIntensity: 0.5 },
  { keywords: ["psychological", "mystery", "thriller", "crime"], complexity: 1.2, morality: 0.9, emotionalIntensity: 0.5 },
  { keywords: ["comedy"], complexity: -0.7, morality: -0.5, emotionalIntensity: -0.2 },
  { keywords: ["historical", "sci-fi", "cyberpunk"], complexity: 0.8, morality: 0.4, emotionalIntensity: 0.2 },
];

const toneMetricRules: Array<{
  keywords: string[];
  complexity: number;
  morality: number;
  emotionalIntensity: number;
}> = [
  { keywords: ["dark", "bleak", "noir", "brutal"], complexity: 0.7, morality: 1.0, emotionalIntensity: 0.5 },
  { keywords: ["emotional", "reflective", "melanch", "sad", "bittersweet", "heartfelt"], complexity: 0.3, morality: 0.1, emotionalIntensity: 1.0 },
  { keywords: ["wholesome", "warm", "soothing", "hopeful", "healing"], complexity: -0.5, morality: -0.7, emotionalIntensity: 0.4 },
  { keywords: ["high-energy", "energetic", "intense", "chaotic", "competitive"], complexity: -0.4, morality: -0.1, emotionalIntensity: 0.5 },
  { keywords: ["psychological", "mind-bending"], complexity: 1.1, morality: 0.9, emotionalIntensity: 0.6 },
];

const normaliseTitle = (title: string) => title.trim().toLowerCase();

const clampRating = (value: number) =>
  Math.min(10, Math.max(1, Math.round(value)));

const clampProfileMetric = (value: number) =>
  Math.min(10, Math.max(1, Math.round(value * 10) / 10));

const findRuleMatch = <TRule extends { keywords: string[] }>(
  value: string,
  rules: TRule[],
): TRule | undefined => {
  const normalised = value.trim().toLowerCase();
  return rules.find((rule) =>
    rule.keywords.some((keyword) => normalised.includes(keyword)),
  );
};

const resolveToneBucket = (tone: string): ToneBucket | null => {
  const direct = toneBuckets.find(
    (bucket) => bucket.toLowerCase() === tone.trim().toLowerCase(),
  );
  if (direct) return direct;

  const matchedRule = findRuleMatch(tone, toneBucketRules);
  return matchedRule ? matchedRule.bucket : null;
};

const resolveGenreToneBucket = (genre: string): ToneBucket | null => {
  const matchedRule = findRuleMatch(genre, genreToneFallbackRules);
  return matchedRule ? matchedRule.bucket : null;
};

const inferToneFromGenres = (genres: string[]): string[] => {
  const buckets = Array.from(
    new Set(
      genres
        .map((genre) => resolveGenreToneBucket(genre))
        .filter((bucket): bucket is ToneBucket => Boolean(bucket)),
    ),
  );

  if (!buckets.length) {
    return ["Emotional", "Reflective"];
  }

  return buckets;
};

const inferProfileMetrics = (
  genres: string[],
  tone: string[],
): Pick<CatalogAnime, "complexity" | "morality" | "emotionalIntensity"> => {
  let complexity = 6;
  let morality = 6;
  let emotionalIntensity = 6.5;

  const uniqueGenres = Array.from(new Set(genres.map((item) => item.toLowerCase())));
  const uniqueTone = Array.from(new Set(tone.map((item) => item.toLowerCase())));

  for (const genre of uniqueGenres) {
    const rule = findRuleMatch(genre, genreMetricRules);
    if (!rule) continue;
    complexity += rule.complexity;
    morality += rule.morality;
    emotionalIntensity += rule.emotionalIntensity;
  }

  for (const toneEntry of uniqueTone) {
    const rule = findRuleMatch(toneEntry, toneMetricRules);
    if (!rule) continue;
    complexity += rule.complexity;
    morality += rule.morality;
    emotionalIntensity += rule.emotionalIntensity;
  }

  return {
    complexity: clampProfileMetric(complexity),
    morality: clampProfileMetric(morality),
    emotionalIntensity: clampProfileMetric(emotionalIntensity),
  };
};

const resolveCompletedRating = (rating: number | null) => {
  if (typeof rating !== "number" || Number.isNaN(rating)) {
    return 1;
  }
  return clampRating(rating);
};

const buildPosterStyle = (
  anime: Pick<CatalogAnime, "posterGradient" | "posterImageUrl">,
  fallbackGradient?: string,
  fit: "contain" | "cover" = "contain",
) => {
  if (anime.posterImageUrl) {
    return {
      backgroundImage: `url('${anime.posterImageUrl}')`,
      backgroundColor: "#0A0A0F",
      backgroundSize: fit,
      backgroundPosition: "center",
      backgroundRepeat: "no-repeat",
    };
  }

  return {
    background: fallbackGradient ?? anime.posterGradient,
  };
};

const simplifyTitle = (title: string) =>
  normaliseTitle(title)
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const resolvePosterCandidate = (
  results: AniListSearchResult[],
  targetTitle: string,
) => {
  if (!results.length) return null;

  const normalisedTarget = normaliseTitle(targetTitle);
  const simplifiedTarget = simplifyTitle(targetTitle);

  const exactWithPoster = results.find(
    (item) =>
      normaliseTitle(item.title) === normalisedTarget &&
      Boolean(item.posterImageUrl),
  );
  if (exactWithPoster) return exactWithPoster;

  const simplifiedExactWithPoster = results.find(
    (item) =>
      simplifyTitle(item.title) === simplifiedTarget &&
      Boolean(item.posterImageUrl),
  );
  if (simplifiedExactWithPoster) return simplifiedExactWithPoster;

  if (simplifiedTarget) {
    const partialWithPoster = results.find((item) => {
      if (!item.posterImageUrl) return false;
      const simplifiedCandidate = simplifyTitle(item.title);
      return (
        simplifiedCandidate.includes(simplifiedTarget) ||
        simplifiedTarget.includes(simplifiedCandidate)
      );
    });

    if (partialWithPoster) return partialWithPoster;
  }

  return (
    results.find((item) => Boolean(item.posterImageUrl)) ??
    results.find((item) => normaliseTitle(item.title) === normalisedTarget) ??
    results[0]
  );
};

const toWatchSignal = (entry: WatchEntry, anime: CatalogAnime | undefined): WatchSignal | null => {
  if (!anime) return null;
  return {
    title: anime.title,
    status: entry.status,
    rating: entry.rating,
    genres: anime.genres,
    tone: anime.tone,
    popularity: anime.popularity,
    complexity: anime.complexity,
    morality: anime.morality,
    emotionalIntensity: anime.emotionalIntensity,
  };
};

const confidenceClass = {
  High: "text-emerald-400",
  Medium: "text-amber-300",
  Low: "text-zinc-400",
} as const;

export default function AniVibeApp() {
  const [activeTab, setActiveTab] = useState<TabId>("tracker");
  const [catalog, setCatalog] = useState<CatalogAnime[]>(SEED_CATALOG);
  const [watchlist, setWatchlist] = useState<WatchEntry[]>(
    DEFAULT_WATCHLIST.map((item) => ({ ...item })),
  );
  const [feedback, setFeedback] = useState<Record<number, FeedbackVote>>({});

  const [recommendations, setRecommendations] = useState<RecommendationResponse | null>(null);
  const [recommendationLoading, setRecommendationLoading] = useState(false);
  const [recommendationPosterByTitle, setRecommendationPosterByTitle] = useState<
    Record<string, PosterLookupResult>
  >({});
  const [vibePosterByTitle, setVibePosterByTitle] = useState<
    Record<string, PosterLookupResult>
  >({});

  const [vibeQuery, setVibeQuery] = useState("");
  const [vibeResponse, setVibeResponse] = useState<VibeResponse | null>(null);
  const [vibeLoading, setVibeLoading] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchResults, setSearchResults] = useState<AniListSearchResult[]>([]);
  const [searchResultsPage, setSearchResultsPage] = useState(1);
  const [searchSuggestions, setSearchSuggestions] = useState<
    AniListSearchResult[]
  >([]);
  const [searchSuggestionsLoading, setSearchSuggestionsLoading] =
    useState(false);
  const [showSearchSuggestions, setShowSearchSuggestions] = useState(false);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1);
  const [quickAddStatusByAnimeId, setQuickAddStatusByAnimeId] = useState<
    Record<number, WatchStatus>
  >({});
  const [watchlistPageByStatus, setWatchlistPageByStatus] = useState<
    Record<WatchStatus, number>
  >(() =>
    WATCH_STATUSES.reduce(
      (accumulator, status) => ({
        ...accumulator,
        [status]: 1,
      }),
      {} as Record<WatchStatus, number>,
    ),
  );

  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isHydrated, setIsHydrated] = useState(false);
  const posterLookupAttemptedRef = useRef(new Set<number>());
  const recommendationPosterLookupAttemptedRef = useRef(new Set<string>());
  const searchBoxRef = useRef<HTMLDivElement | null>(null);

  const catalogMap = useMemo(() => {
    return new Map(catalog.map((item) => [item.id, item]));
  }, [catalog]);

  const watchSignals = useMemo(() => {
    return watchlist
      .map((entry) => toWatchSignal(entry, catalogMap.get(entry.animeId)))
      .filter((entry): entry is WatchSignal => Boolean(entry));
  }, [watchlist, catalogMap]);

  const searchResultsTotalPages = useMemo(
    () => Math.max(1, Math.ceil(searchResults.length / SEARCH_RESULTS_PAGE_SIZE)),
    [searchResults.length],
  );

  const pagedSearchResults = useMemo(() => {
    const startIndex = (searchResultsPage - 1) * SEARCH_RESULTS_PAGE_SIZE;
    return searchResults.slice(startIndex, startIndex + SEARCH_RESULTS_PAGE_SIZE);
  }, [searchResults, searchResultsPage]);

  const watchlistByStatus = useMemo(() => {
    return WATCH_STATUSES.map((status) => {
      const allItems = watchlist.filter((entry) => entry.status === status);
      const totalItems = allItems.length;
      const totalPages = Math.max(1, Math.ceil(totalItems / WATCHLIST_PAGE_SIZE));
      const currentPage = Math.min(
        watchlistPageByStatus[status] ?? 1,
        totalPages,
      );
      const startIndex = (currentPage - 1) * WATCHLIST_PAGE_SIZE;

      return {
        status,
        items: allItems.slice(startIndex, startIndex + WATCHLIST_PAGE_SIZE),
        totalItems,
        currentPage,
        totalPages,
      };
    });
  }, [watchlist, watchlistPageByStatus]);

  const profileSummary = useMemo(() => {
    const weightedEntries = watchSignals.map((item) => ({
      item,
      weight: item.rating ? item.rating / 2 : item.status === "Completed" ? 3 : 1,
    }));

    if (!weightedEntries.length) {
      return {
        hasData: false,
        topGenres: [] as Array<{ genre: string; value: number }>,
        toneDistribution: toneBuckets.map((bucket) => ({ name: bucket, value: 0 })),
        complexity: 0,
        morality: 0,
        emotionalIntensity: 0,
        narrativeSummary: "No taste profile yet. Add anime to your tracker to generate this score.",
        moralitySummary: "No taste profile yet. Add anime to your tracker to generate this score.",
        emotionSummary: "No taste profile yet. Add anime to your tracker to generate this score.",
      };
    }

    const genreScores = new Map<string, number>();
    const toneBucketScores = new Map<ToneBucket, number>(
      toneBuckets.map((bucket) => [bucket, 0]),
    );

    for (const { item, weight } of weightedEntries) {
      for (const genre of item.genres) {
        genreScores.set(genre, (genreScores.get(genre) ?? 0) + weight);
      }
      const matchedToneBuckets = Array.from(
        new Set(
          item.tone
            .map((tone) => resolveToneBucket(tone))
            .filter((bucket): bucket is ToneBucket => Boolean(bucket)),
        ),
      );

      const fallbackToneBuckets =
        matchedToneBuckets.length > 0
          ? matchedToneBuckets
          : Array.from(
              new Set(
                item.genres
                  .map((genre) => resolveGenreToneBucket(genre))
                  .filter((bucket): bucket is ToneBucket => Boolean(bucket)),
              ),
            );

      if (!fallbackToneBuckets.length) {
        continue;
      }

      const weightPerBucket = weight / fallbackToneBuckets.length;
      for (const bucket of fallbackToneBuckets) {
        toneBucketScores.set(
          bucket,
          (toneBucketScores.get(bucket) ?? 0) + weightPerBucket,
        );
      }
    }

    const topGenres = [...genreScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([genre, value]) => ({ genre, value: Math.round(value * 10) / 10 }));

    const toneBase = toneBuckets.map((bucket) => ({
      bucket,
      value: toneBucketScores.get(bucket) ?? 0,
    }));

    const toneTotal = toneBase.reduce((sum, row) => sum + row.value, 0) || 1;
    const toneDistribution = toneBase.map((row) => ({
      name: row.bucket,
      value: Math.round((row.value / toneTotal) * 100),
    }));

    const weightedAverage = (selector: (signal: WatchSignal) => number) => {
      const weightedSum = weightedEntries.reduce((sum, row) => sum + selector(row.item) * row.weight, 0);
      const weightTotal = weightedEntries.reduce((sum, row) => sum + row.weight, 0) || 1;
      return Math.round((weightedSum / weightTotal) * 10) / 10;
    };

    const complexity = weightedAverage((item) => item.complexity);
    const morality = weightedAverage((item) => item.morality);
    const emotionalIntensity = weightedAverage((item) => item.emotionalIntensity);

    const narrativeSummary =
      complexity >= 7.5
        ? "You gravitate toward layered narratives with strategic or psychological complexity."
        : "You prefer balanced pacing and accessible storytelling with clear momentum.";

    const moralitySummary =
      morality >= 7.5
        ? "Morally gray systems and conflicted protagonists are strong signals in your profile."
        : "You lean toward cleaner value systems and emotionally direct character journeys.";

    const emotionSummary =
      emotionalIntensity >= 7.5
        ? "You consistently choose high emotional-intensity stories over purely casual watches."
        : "You keep a mixed emotional profile with room for lighter, low-pressure titles.";

    return {
      hasData: true,
      topGenres,
      toneDistribution,
      complexity,
      morality,
      emotionalIntensity,
      narrativeSummary,
      moralitySummary,
      emotionSummary,
    };
  }, [watchSignals]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<PersistedState>;
        if (Array.isArray(parsed.catalog)) setCatalog(parsed.catalog);
        if (Array.isArray(parsed.watchlist)) setWatchlist(parsed.watchlist);
        if (parsed.feedback && typeof parsed.feedback === "object") {
          setFeedback(parsed.feedback as Record<number, FeedbackVote>);
        }
      }
    } catch {
      setStatusMessage("Could not restore prior local state. Using fresh defaults.");
    } finally {
      setIsHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!isHydrated) return;

    const seedCatalogIds = new Set(SEED_CATALOG.map((anime) => anime.id));
    setCatalog((current) => {
      let changed = false;

      const next = current.map((anime) => {
        if (seedCatalogIds.has(anime.id)) {
          return anime;
        }

        const isLegacyFlatProfile =
          (anime.complexity === 6.5 && anime.morality === 6.5 && anime.emotionalIntensity === 7) ||
          (anime.complexity === 7 && anime.morality === 7 && anime.emotionalIntensity === 7);

        const hasGenericTone =
          anime.tone.length === 2 &&
          anime.tone.includes("Emotional") &&
          anime.tone.includes("Reflective");

        if (!isLegacyFlatProfile && !hasGenericTone) {
          return anime;
        }

        const inferredTone = anime.tone.length
          ? anime.tone
          : inferToneFromGenres(anime.genres);
        const inferredProfile = inferProfileMetrics(anime.genres, inferredTone);

        const needsUpdate =
          anime.tone.join("|") !== inferredTone.join("|") ||
          anime.complexity !== inferredProfile.complexity ||
          anime.morality !== inferredProfile.morality ||
          anime.emotionalIntensity !== inferredProfile.emotionalIntensity;

        if (!needsUpdate) {
          return anime;
        }

        changed = true;
        return {
          ...anime,
          tone: inferredTone,
          ...inferredProfile,
        };
      });

      return changed ? next : current;
    });
  }, [isHydrated]);

  useEffect(() => {
    if (!isHydrated) return;
    const value: PersistedState = { catalog, watchlist, feedback };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  }, [catalog, watchlist, feedback, isHydrated]);

  useEffect(() => {
    setSearchResultsPage((current) => Math.min(current, searchResultsTotalPages));
  }, [searchResultsTotalPages]);

  useEffect(() => {
    const query = searchQuery.trim();
    if (query.length < 2) {
      setSearchSuggestions([]);
      setSearchSuggestionsLoading(false);
      setActiveSuggestionIndex(-1);
      return;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      setSearchSuggestionsLoading(true);

      try {
        const response = await fetch(
          `/api/anilist/search?q=${encodeURIComponent(query)}`,
          { signal: controller.signal },
        );

        if (!response.ok) {
          setSearchSuggestions([]);
          return;
        }

        const payload = (await response.json()) as {
          items?: AniListSearchResult[];
        };

        const nextSuggestions = (payload.items ?? []).slice(0, 8);
        setSearchSuggestions(nextSuggestions);
        setActiveSuggestionIndex(nextSuggestions.length ? 0 : -1);
      } catch {
        setSearchSuggestions([]);
        setActiveSuggestionIndex(-1);
      } finally {
        setSearchSuggestionsLoading(false);
      }
    }, 250);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [searchQuery]);

  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!searchBoxRef.current?.contains(target)) {
        setShowSearchSuggestions(false);
        setActiveSuggestionIndex(-1);
      }
    };

    document.addEventListener("mousedown", handleOutsideClick);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
    };
  }, []);

  useEffect(() => {
    setWatchlistPageByStatus((current) => {
      let changed = false;
      const next = { ...current };

      for (const status of WATCH_STATUSES) {
        const totalItems = watchlist.filter((entry) => entry.status === status).length;
        const totalPages = Math.max(1, Math.ceil(totalItems / WATCHLIST_PAGE_SIZE));
        const currentPage = next[status] ?? 1;

        if (currentPage > totalPages) {
          next[status] = totalPages;
          changed = true;
        }

        if (!next[status]) {
          next[status] = 1;
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [watchlist]);

  useEffect(() => {
    if (!isHydrated) return;

    const candidates = catalog
      .filter(
        (anime) =>
          !anime.posterImageUrl &&
          !posterLookupAttemptedRef.current.has(anime.id),
      )
      .slice(0, 8);

    if (!candidates.length) return;

    for (const anime of candidates) {
      posterLookupAttemptedRef.current.add(anime.id);
    }

    let cancelled = false;

    const enrichMissingPosters = async () => {
      const posterResults = await Promise.all(
        candidates.map(async (anime) => {
          try {
            const response = await fetch(
              `/api/anilist/search?q=${encodeURIComponent(anime.title)}`,
            );

            if (!response.ok) return null;

            const payload = (await response.json()) as {
              items?: AniListSearchResult[];
            };

            const results = payload.items ?? [];
            const bestMatch = resolvePosterCandidate(results, anime.title);

            if (!bestMatch?.posterImageUrl) return null;

            return {
              animeId: anime.id,
              posterImageUrl: bestMatch.posterImageUrl,
              posterColor: bestMatch.posterColor,
            };
          } catch {
            return null;
          }
        }),
      );

      if (cancelled) return;

      const updates = posterResults.filter(
        (result): result is NonNullable<typeof result> => Boolean(result),
      );

      if (!updates.length) return;

      setCatalog((current) =>
        current.map((anime) => {
          const update = updates.find((item) => item.animeId === anime.id);
          if (!update) return anime;

          return {
            ...anime,
            posterImageUrl: update.posterImageUrl,
            posterGradient: anime.posterGradient.includes("linear-gradient")
              ? anime.posterGradient
              : `linear-gradient(160deg, ${update.posterColor || "#7B5EFF"} 0%, #0A0A0F 100%)`,
          };
        }),
      );
    };

    void enrichMissingPosters();

    return () => {
      cancelled = true;
    };
  }, [catalog, isHydrated]);

  useEffect(() => {
    const items = recommendations?.items ?? [];
    if (!items.length) return;

    const titlesToLookup = items
      .map((item) => item.title)
      .map((title) => title.trim())
      .filter(Boolean)
      .filter((title) => {
        const key = normaliseTitle(title);
        if (recommendationPosterLookupAttemptedRef.current.has(key)) {
          return false;
        }

        const existingCatalogAnime = catalog.find(
          (anime) => normaliseTitle(anime.title) === key,
        );

        if (existingCatalogAnime?.posterImageUrl) {
          return false;
        }

        return true;
      });

    if (!titlesToLookup.length) return;

    for (const title of titlesToLookup) {
      recommendationPosterLookupAttemptedRef.current.add(normaliseTitle(title));
    }

    let cancelled = false;

    const lookupPosters = async () => {
      const results = await Promise.all(
        titlesToLookup.map(async (title) => {
          const key = normaliseTitle(title);
          try {
            const response = await fetch(
              `/api/anilist/search?q=${encodeURIComponent(title)}`,
            );

            if (!response.ok) {
              return { key, value: null, shouldRetry: true };
            }

            const payload = (await response.json()) as {
              items?: AniListSearchResult[];
            };

            const candidates = payload.items ?? [];
            const best = resolvePosterCandidate(candidates, title);

            if (!best) {
              return { key, value: null, shouldRetry: false };
            }

            return {
              key,
              value: {
                posterImageUrl: best.posterImageUrl,
                posterColor: best.posterColor,
              },
              shouldRetry: false,
            };
          } catch {
            return { key, value: null, shouldRetry: true };
          }
        }),
      );

      if (cancelled) return;

      const updates = results.filter(
        (result): result is { key: string; value: PosterLookupResult; shouldRetry: boolean } =>
          Boolean(result.value),
      );

      if (updates.length) {
        setRecommendationPosterByTitle((current) => {
          const next = { ...current };
          for (const update of updates) {
            next[update.key] = update.value;
          }
          return next;
        });
      }

      const retryKeys = results
        .filter((result) => result.shouldRetry)
        .map((result) => result.key);

      if (retryKeys.length) {
        for (const key of retryKeys) {
          recommendationPosterLookupAttemptedRef.current.delete(key);
        }
      }
    };

    void lookupPosters();

    return () => {
      cancelled = true;
    };
  }, [recommendations, catalog]);

  useEffect(() => {
    const items = vibeResponse?.items ?? [];
    if (!items.length) return;

    const titlesToLookup = Array.from(
      new Set(items.map((item) => item.title)),
    )
      .map((title) => title.trim())
      .filter(Boolean)
      .filter((title) => {
        const key = normaliseTitle(title);
        const existingCatalogAnime = catalog.find(
          (anime) => normaliseTitle(anime.title) === key,
        );

        if (existingCatalogAnime?.posterImageUrl) {
          return false;
        }

        if (key in vibePosterByTitle) {
          return false;
        }

        return true;
      });

    if (!titlesToLookup.length) return;

    let cancelled = false;

    const lookupPosters = async () => {
      const results = await Promise.all(
        titlesToLookup.map(async (title) => {
          try {
            const response = await fetch(
              `/api/anilist/search?q=${encodeURIComponent(title)}`,
            );

            if (!response.ok) return null;

            const payload = (await response.json()) as {
              items?: AniListSearchResult[];
            };

            const candidates = payload.items ?? [];
            const best = resolvePosterCandidate(candidates, title);

            if (!best) return null;

            return {
              key: normaliseTitle(title),
              value: {
                posterImageUrl: best.posterImageUrl,
                posterColor: best.posterColor,
              },
            };
          } catch {
            return null;
          }
        }),
      );

      if (cancelled) return;

      const updates = results.filter(
        (result): result is NonNullable<typeof result> => Boolean(result),
      );

      if (!updates.length) return;

      setVibePosterByTitle((current) => {
        const next = { ...current };
        for (const update of updates) {
          next[update.key] = update.value;
        }
        return next;
      });
    };

    void lookupPosters();

    return () => {
      cancelled = true;
    };
  }, [vibeResponse, catalog, vibePosterByTitle]);

  const setEntryPatch = (animeId: number, patch: Partial<WatchEntry>) => {
    setWatchlist((current) =>
      current.map((entry) =>
        entry.animeId === animeId
          ? (() => {
              const nextEntry = {
                ...entry,
                ...patch,
              };

              if (nextEntry.status === "Completed") {
                return {
                  ...nextEntry,
                  rating: resolveCompletedRating(nextEntry.rating),
                };
              }

              return nextEntry;
            })()
          : entry,
      ),
    );
  };

  const addCatalogAnime = (input: AniListSearchResult) => {
    setCatalog((current) => {
      if (current.some((anime) => anime.id === input.id)) return current;

      const genres = input.genres.length ? input.genres : ["Drama"];
      const tone = inferToneFromGenres(genres);
      const profile = inferProfileMetrics(genres, tone);

      return [
        {
          id: input.id,
          title: input.title,
          genres,
          tone,
          synopsis: input.synopsis,
          episodes: input.episodes || 12,
          popularity: Math.min(100, Math.max(30, input.popularity || 60)),
          ...profile,
          posterGradient: `linear-gradient(160deg, ${input.posterColor || "#7B5EFF"} 0%, #0A0A0F 100%)`,
          posterImageUrl: input.posterImageUrl ?? undefined,
        },
        ...current,
      ];
    });
  };

  const addToWatchlist = (animeId: number, status: WatchStatus = "Plan-to-Watch") => {
    setWatchlist((current) => {
      if (current.some((entry) => entry.animeId === animeId)) {
        setStatusMessage("Anime already exists in your lists.");
        return current;
      }
      setStatusMessage("Anime added to your tracking list.");
      return [
        {
          animeId,
          status,
          progress: 0,
          rating: status === "Completed" ? 1 : null,
          review: "",
        },
        ...current,
      ];
    });
  };

  const getQuickAddStatus = (animeId: number) =>
    quickAddStatusByAnimeId[animeId] ?? "Plan-to-Watch";

  const setQuickAddStatus = (animeId: number, status: WatchStatus) => {
    setQuickAddStatusByAnimeId((current) => ({
      ...current,
      [animeId]: status,
    }));
  };

  const removeFromWatchlist = (animeId: number) => {
    setWatchlist((current) => current.filter((entry) => entry.animeId !== animeId));
  };

  const setWatchlistPage = (status: WatchStatus, page: number) => {
    setWatchlistPageByStatus((current) => ({
      ...current,
      [status]: Math.max(1, page),
    }));
  };

  const searchAniList = async (queryOverride?: string) => {
    const query = (queryOverride ?? searchQuery).trim();
    if (!query) return;

    setSearchLoading(true);
    setStatusMessage(null);
    setShowSearchSuggestions(false);
    setActiveSuggestionIndex(-1);
    if (queryOverride) setSearchQuery(query);

    try {
      const response = await fetch(
        `/api/anilist/search?q=${encodeURIComponent(query)}`,
      );
      const payload = (await response.json()) as { items?: AniListSearchResult[]; error?: string };

      if (!response.ok) {
        setStatusMessage(payload.error ?? "AniList search failed.");
        setSearchResults([]);
        setSearchResultsPage(1);
        return;
      }

      setSearchResults(payload.items ?? []);
      setSearchResultsPage(1);
      if (!(payload.items ?? []).length) {
        setStatusMessage("No matches found for that title.");
      }
    } catch {
      setStatusMessage("AniList is temporarily unreachable. Try again in a moment.");
      setSearchResults([]);
      setSearchResultsPage(1);
    } finally {
      setSearchLoading(false);
    }
  };

  const generateRecommendations = async () => {
    setRecommendationLoading(true);
    setStatusMessage(null);

    try {
      const response = await fetch("/api/gemini/recommendations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ history: watchSignals, feedback }),
      });

      const payload = (await response.json()) as RecommendationResponse;
      setRecommendations(payload);
    } catch {
      setStatusMessage("Recommendation generation failed. Please retry.");
    } finally {
      setRecommendationLoading(false);
    }
  };

  const runVibeMode = async () => {
    if (!vibeQuery.trim()) {
      setStatusMessage("Enter a vibe prompt first (e.g. sad but beautiful).\n");
      return;
    }

    // Reset lookup cache so each vibe run can retry missing posters without refresh.
    setVibePosterByTitle({});
    setVibeLoading(true);
    setStatusMessage(null);

    try {
      const response = await fetch("/api/gemini/vibe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: vibeQuery.trim(), history: watchSignals }),
      });

      const payload = (await response.json()) as VibeResponse | { error: string };
      if (!response.ok || "error" in payload) {
        setStatusMessage("Vibe request failed. Please adjust your prompt and retry.");
        return;
      }
      setVibeResponse(payload);
    } catch {
      setStatusMessage("Vibe Mode request failed. Please retry.");
    } finally {
      setVibeLoading(false);
    }
  };

  const applyFeedback = (animeId: number, vote: FeedbackVote) => {
    setFeedback((current) => ({ ...current, [animeId]: vote }));
  };

  const ensureRecommendationTracked = (
    item: RecommendationItem,
    status: WatchStatus = "Plan-to-Watch",
  ) => {
    const existing = catalog.find((anime) => normaliseTitle(anime.title) === normaliseTitle(item.title));
    const animeId = existing?.id ?? item.id;

    if (!existing) {
      const genres = item.genres.length ? item.genres : ["Drama"];
      const tone = item.tone.length ? item.tone : inferToneFromGenres(genres);
      const profile = inferProfileMetrics(genres, tone);

      setCatalog((current) => [
        {
          id: animeId,
          title: item.title,
          genres,
          tone,
          synopsis: item.reason,
          episodes: 12,
          popularity: item.hiddenGem ? 45 : 70,
          ...profile,
          posterGradient: posterGradients[Math.abs(animeId) % posterGradients.length],
        },
        ...current,
      ]);
    }

    addToWatchlist(animeId, status);
  };

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <header className="border-b border-white/10 px-4 py-4 md:px-8">
        <div className="mx-auto flex w-full max-w-7xl justify-center">
          <div className="flex items-center gap-4 md:gap-6">
          <div className="relative h-16 w-16 flex-none overflow-hidden rounded-xl border border-white/15 bg-black/20 md:h-24 md:w-24">
            <Image
              src={anivibeLogo}
              alt="AniVibe logo"
              fill
              priority
              className="object-cover"
            />
          </div>

          <div className="min-w-0">
            <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">AniVibe</p>
            <h1 className="text-2xl font-bold md:text-3xl">Track. Discover. Understand your anime taste.</h1>
          </div>
          </div>
        </div>
      </header>

      <nav className="mx-auto mt-4 grid w-full max-w-7xl grid-cols-2 gap-2 px-4 md:grid-cols-4 md:px-8">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center justify-center gap-2 rounded-xl border px-4 py-3 text-sm transition ${
                isActive
                  ? "border-[var(--accent)] bg-[var(--surface)] text-white"
                  : "border-white/10 bg-[var(--surface)]/60 text-[var(--muted)] hover:border-white/25"
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          );
        })}
      </nav>

      {statusMessage ? (
        <p className="mx-auto mt-3 w-full max-w-7xl rounded-lg border border-[var(--accent)]/30 bg-[var(--surface)] px-4 py-2 text-sm text-[var(--muted)]">
          {statusMessage}
        </p>
      ) : null}

      <main className="mx-auto w-full max-w-7xl px-4 py-6 md:px-8 md:py-8">
        {activeTab === "tracker" ? (
          <section className="space-y-6">
            <div className="rounded-2xl border border-white/10 bg-[var(--surface)] p-4 md:p-6">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-lg font-semibold">Smart Anime Tracking</h2>
                <p className="text-xs text-[var(--muted)]">Watching · Completed · On-Hold · Plan-to-Watch</p>
              </div>

              <div className="flex flex-col gap-3 md:flex-row">
                <div ref={searchBoxRef} className="relative flex-1">
                  <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-[var(--bg)] px-3">
                    <Search size={16} className="text-[var(--muted)]" />
                    <input
                      value={searchQuery}
                      onChange={(event) => {
                        setSearchQuery(event.target.value);
                        setShowSearchSuggestions(true);
                        setActiveSuggestionIndex(0);
                      }}
                      onFocus={() => {
                        setShowSearchSuggestions(true);
                        if (searchSuggestions.length) {
                          setActiveSuggestionIndex((current) =>
                            current >= 0 ? current : 0,
                          );
                        }
                      }}
                      onKeyDown={(event) => {
                        if (
                          event.key === "ArrowDown" &&
                          showSearchSuggestions &&
                          searchSuggestions.length
                        ) {
                          event.preventDefault();
                          setActiveSuggestionIndex((current) =>
                            current < searchSuggestions.length - 1 ? current + 1 : 0,
                          );
                          return;
                        }

                        if (
                          event.key === "ArrowUp" &&
                          showSearchSuggestions &&
                          searchSuggestions.length
                        ) {
                          event.preventDefault();
                          setActiveSuggestionIndex((current) =>
                            current > 0 ? current - 1 : searchSuggestions.length - 1,
                          );
                          return;
                        }

                        if (event.key === "Enter") {
                          event.preventDefault();
                          if (
                            showSearchSuggestions &&
                            activeSuggestionIndex >= 0 &&
                            activeSuggestionIndex < searchSuggestions.length
                          ) {
                            void searchAniList(
                              searchSuggestions[activeSuggestionIndex].title,
                            );
                            return;
                          }
                          void searchAniList();
                        }
                        if (event.key === "Escape") {
                          setShowSearchSuggestions(false);
                          setActiveSuggestionIndex(-1);
                        }
                      }}
                      placeholder="Search anime on AniList"
                      className="h-11 w-full bg-transparent text-sm outline-none"
                    />
                  </div>

                  {showSearchSuggestions && searchQuery.trim().length >= 2 ? (
                    <div className="absolute left-0 right-0 top-full z-20 mt-2 max-h-80 overflow-y-auto rounded-xl border border-white/10 bg-[var(--surface)] p-2 shadow-xl">
                      {searchSuggestionsLoading ? (
                        <p className="px-2 py-2 text-xs text-[var(--muted)]">
                          Loading suggestions...
                        </p>
                      ) : searchSuggestions.length ? (
                        <div className="space-y-1">
                          {searchSuggestions.map((suggestion, index) => (
                            <button
                              key={suggestion.id}
                              type="button"
                              onClick={() => void searchAniList(suggestion.title)}
                              onMouseEnter={() => setActiveSuggestionIndex(index)}
                              className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition ${
                                index === activeSuggestionIndex
                                  ? "bg-white/10"
                                  : "hover:bg-white/5"
                              }`}
                            >
                              <span className="line-clamp-1 text-sm font-medium text-white">
                                {suggestion.title}
                              </span>
                              <span className="line-clamp-1 text-xs text-[var(--muted)]">
                                {suggestion.genres.slice(0, 2).join(" • ")}
                              </span>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <p className="px-2 py-2 text-xs text-[var(--muted)]">
                          No suggestions found.
                        </p>
                      )}
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => void searchAniList()}
                  disabled={searchLoading}
                  className="h-11 rounded-xl bg-[var(--accent)] px-4 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-60"
                >
                  {searchLoading ? "Searching..." : "Search"}
                </button>
              </div>

              {searchResults.length ? (
                <>
                <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {pagedSearchResults.map((result) => (
                    <div key={result.id} className="flex gap-4 rounded-xl border border-white/10 bg-black/30 p-4">
                      <div
                        className="h-40 w-28 flex-none rounded-lg md:h-44 md:w-32"
                        style={
                          result.posterImageUrl
                            ? {
                                backgroundImage: `url('${result.posterImageUrl}')`,
                                backgroundColor: "#0A0A0F",
                                backgroundSize: "contain",
                                backgroundPosition: "center",
                                backgroundRepeat: "no-repeat",
                              }
                            : {
                                background: `linear-gradient(160deg, ${result.posterColor || "#7B5EFF"} 0%, #0A0A0F 100%)`,
                              }
                        }
                      />
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-2 text-base font-semibold leading-tight">{result.title}</p>
                        <p className="mt-1 line-clamp-3 text-xs text-[var(--muted)]">{result.synopsis}</p>
                        <div className="mt-2 flex flex-wrap gap-1">
                          {result.genres.slice(0, 2).map((genre) => (
                            <span key={genre} className="rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-[var(--muted)]">
                              {genre}
                            </span>
                          ))}
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            addCatalogAnime(result);
                            addToWatchlist(result.id, getQuickAddStatus(result.id));
                          }}
                          className="mt-3 rounded-lg bg-[var(--secondary)] px-3 py-1.5 text-xs font-medium text-white"
                        >
                          Add to List
                        </button>
                        <select
                          value={getQuickAddStatus(result.id)}
                          onChange={(event) =>
                            setQuickAddStatus(result.id, event.target.value as WatchStatus)
                          }
                          className="mt-2 h-8 w-full rounded-md border border-white/15 bg-[var(--bg)] px-2 text-xs outline-none"
                        >
                          {WATCH_STATUSES.map((status) => (
                            <option key={status} value={status}>
                              {status}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  ))}
                </div>
                {searchResultsTotalPages > 1 ? (
                  <div className="mt-4 flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() =>
                        setSearchResultsPage((current) => Math.max(1, current - 1))
                      }
                      disabled={searchResultsPage === 1}
                      className="h-9 rounded-md border border-white/15 px-3 text-xs text-[var(--muted)] disabled:opacity-40"
                    >
                      Prev
                    </button>
                    <p className="text-xs text-[var(--muted)]">
                      Search Page {searchResultsPage} / {searchResultsTotalPages}
                    </p>
                    <button
                      type="button"
                      onClick={() =>
                        setSearchResultsPage((current) =>
                          Math.min(searchResultsTotalPages, current + 1),
                        )
                      }
                      disabled={searchResultsPage >= searchResultsTotalPages}
                      className="h-9 rounded-md border border-white/15 px-3 text-xs text-[var(--muted)] disabled:opacity-40"
                    >
                      Next
                    </button>
                  </div>
                ) : null}
                </>
              ) : null}
            </div>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {watchlistByStatus.map((group) => (
                <div key={group.status} className="rounded-2xl border border-white/10 bg-[var(--surface)] p-5">
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="font-semibold">{group.status}</h3>
                    <span className="rounded-full border border-white/10 px-2 py-0.5 text-xs text-[var(--muted)]">
                      {group.totalItems}
                    </span>
                  </div>

                  <div className="space-y-3">
                    {group.items.length === 0 ? (
                      <p className="text-xs text-[var(--muted)]">No titles yet.</p>
                    ) : (
                      group.items.map((entry) => {
                        const anime = catalogMap.get(entry.animeId);
                        if (!anime) return null;

                        return (
                          <article key={entry.animeId} className="overflow-hidden rounded-xl border border-white/10 bg-black/30">
                            <div
                              className="aspect-[2/3] w-full border-b border-white/10"
                              style={buildPosterStyle(anime, undefined, "cover")}
                            />
                            <div className="space-y-2 p-3 md:p-4">
                              <p className="text-sm font-semibold leading-tight">{anime.title}</p>
                              <p className="text-xs text-[var(--muted)]">
                                {entry.progress}/{anime.episodes} episodes
                              </p>

                              <div className="flex items-center gap-2">
                                <input
                                  type="number"
                                  min={0}
                                  max={anime.episodes}
                                  value={entry.progress}
                                  onChange={(event) =>
                                    setEntryPatch(entry.animeId, {
                                      progress: Math.max(0, Number(event.target.value) || 0),
                                    })
                                  }
                                  className="h-8 w-20 rounded-md border border-white/15 bg-[var(--bg)] px-2 text-xs outline-none"
                                />
                                <button
                                  type="button"
                                  onClick={() =>
                                    setEntryPatch(entry.animeId, {
                                      progress: Math.min(anime.episodes, entry.progress + 1),
                                    })
                                  }
                                  className="h-8 rounded-md border border-white/15 px-2 text-xs text-[var(--muted)]"
                                >
                                  +1 EP
                                </button>
                              </div>

                              <select
                                value={entry.status}
                                onChange={(event) =>
                                  setEntryPatch(entry.animeId, {
                                    status: event.target.value as WatchStatus,
                                  })
                                }
                                className="h-8 w-full rounded-md border border-white/15 bg-[var(--bg)] px-2 text-xs outline-none"
                              >
                                {WATCH_STATUSES.map((status) => (
                                  <option key={status} value={status}>
                                    {status}
                                  </option>
                                ))}
                              </select>

                              {entry.status === "Completed" ? (
                                <>
                                  <label className="flex items-center justify-between text-xs text-[var(--muted)]">
                                    Rating
                                    <span>{resolveCompletedRating(entry.rating)}/10</span>
                                  </label>
                                  <input
                                    type="range"
                                    min={1}
                                    max={10}
                                    value={resolveCompletedRating(entry.rating)}
                                    onChange={(event) =>
                                      setEntryPatch(entry.animeId, {
                                        rating: clampRating(Number(event.target.value)),
                                      })
                                    }
                                    className="w-full accent-[var(--accent)]"
                                  />
                                  <textarea
                                    value={entry.review}
                                    onChange={(event) =>
                                      setEntryPatch(entry.animeId, {
                                        review: event.target.value,
                                      })
                                    }
                                    placeholder="Quick review..."
                                    rows={2}
                                    className="w-full rounded-md border border-white/15 bg-[var(--bg)] p-2 text-xs outline-none"
                                  />
                                </>
                              ) : null}

                              <button
                                type="button"
                                onClick={() => removeFromWatchlist(entry.animeId)}
                                className="w-full rounded-md border border-red-300/30 bg-red-950/20 py-1.5 text-xs text-red-200"
                              >
                                Remove
                              </button>
                            </div>
                          </article>
                        );
                      })
                    )}
                  </div>

                  {group.totalItems > 0 && group.totalPages > 1 ? (
                    <div className="mt-3 flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          setWatchlistPage(group.status, group.currentPage - 1)
                        }
                        disabled={group.currentPage === 1}
                        className="h-8 rounded-md border border-white/15 px-3 text-xs text-[var(--muted)] disabled:opacity-40"
                      >
                        Prev
                      </button>
                      <p className="text-xs text-[var(--muted)]">
                        Page {group.currentPage} / {group.totalPages}
                      </p>
                      <button
                        type="button"
                        onClick={() =>
                          setWatchlistPage(group.status, Math.min(group.totalPages, group.currentPage + 1))
                        }
                        disabled={group.currentPage >= group.totalPages}
                        className="h-8 rounded-md border border-white/15 px-3 text-xs text-[var(--muted)] disabled:opacity-40"
                      >
                        Next
                      </button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {activeTab === "discover" ? (
          <section className="space-y-4">
            <div className="rounded-2xl border border-white/10 bg-[var(--surface)] p-5">
              <h2 className="text-lg font-semibold">AI-Powered Recommendations</h2>
              <p className="mt-1 text-sm text-[var(--muted)]">
                Generates 10 profile-aware picks with rationale and hidden gem prioritization.
              </p>
              <button
                type="button"
                onClick={generateRecommendations}
                disabled={recommendationLoading}
                className="mt-4 inline-flex h-11 items-center gap-2 rounded-xl bg-[var(--accent)] px-4 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-60"
              >
                <Sparkles size={16} />
                {recommendationLoading ? "Analyzing profile..." : "Generate Top Picks"}
              </button>
            </div>

            {recommendations ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-xs text-[var(--muted)]">
                  <span>Source: {recommendations.source === "gemini" ? "Gemini" : "Fallback"}</span>
                  <span>Latency: {recommendations.latencyMs}ms</span>
                </div>
                {recommendations.source === "fallback" && recommendations.fallbackReason ? (
                  <p className="text-xs text-amber-300">
                    Fallback reason: {recommendations.fallbackReason}
                  </p>
                ) : null}

                <div className="grid gap-4 md:grid-cols-2">
                  {recommendations.items.map((item) => {
                    const linkedAnime = catalog.find(
                      (anime) => normaliseTitle(anime.title) === normaliseTitle(item.title),
                    );
                    const lookedUpPoster = recommendationPosterByTitle[
                      normaliseTitle(item.title)
                    ];

                    return (
                      <article key={`${item.id}-${item.title}`} className="flex gap-4 rounded-xl border border-white/10 bg-[var(--surface)] p-4">
                        <div
                          className="h-40 w-28 flex-none rounded-lg md:h-44 md:w-32"
                          style={
                            linkedAnime?.posterImageUrl
                              ? buildPosterStyle(
                                  linkedAnime,
                                  posterGradients[Math.abs(item.id) % posterGradients.length],
                                  "cover",
                                )
                              : lookedUpPoster?.posterImageUrl
                                ? {
                                    backgroundImage: `url('${lookedUpPoster.posterImageUrl}')`,
                                    backgroundColor: "#0A0A0F",
                                    backgroundSize: "cover",
                                    backgroundPosition: "center",
                                    backgroundRepeat: "no-repeat",
                                  }
                                : linkedAnime
                                  ? buildPosterStyle(
                                      linkedAnime,
                                      posterGradients[Math.abs(item.id) % posterGradients.length],
                                      "cover",
                                    )
                              : {
                                  background: `linear-gradient(160deg, ${lookedUpPoster?.posterColor || "#7B5EFF"} 0%, #0A0A0F 100%)`,
                                }
                          }
                        />
                        <div className="min-w-0 space-y-3">
                          <div className="flex items-center justify-between gap-3">
                            <h3 className="text-base font-semibold">{item.title}</h3>
                            <span className={`text-xs font-medium ${confidenceClass[item.confidence]}`}>
                              {item.confidence}
                            </span>
                          </div>

                          <p className="line-clamp-4 text-sm text-[var(--muted)]">{item.reason}</p>

                          <div className="flex flex-wrap gap-1">
                            {item.genres.slice(0, 2).map((genre) => (
                              <span key={genre} className="rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-[var(--muted)]">
                                {genre}
                              </span>
                            ))}
                            {item.hiddenGem ? (
                              <span className="rounded-full border border-[var(--secondary)]/40 bg-[var(--secondary)]/15 px-2 py-0.5 text-[11px] text-violet-200">
                                Hidden Gem
                              </span>
                            ) : null}
                          </div>

                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => applyFeedback(item.id, "like")}
                              className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs ${
                                feedback[item.id] === "like"
                                  ? "border-emerald-400/60 bg-emerald-500/20 text-emerald-200"
                                  : "border-white/15 text-[var(--muted)]"
                              }`}
                            >
                              <ThumbsUp size={14} />
                              Like
                            </button>
                            <button
                              type="button"
                              onClick={() => applyFeedback(item.id, "dislike")}
                              className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs ${
                                feedback[item.id] === "dislike"
                                  ? "border-red-400/60 bg-red-500/20 text-red-200"
                                  : "border-white/15 text-[var(--muted)]"
                              }`}
                            >
                              <ThumbsDown size={14} />
                              Dislike
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                ensureRecommendationTracked(item, getQuickAddStatus(item.id))
                              }
                              className="inline-flex items-center gap-1 rounded-md border border-[var(--secondary)]/40 bg-[var(--secondary)]/15 px-2.5 py-1.5 text-xs text-violet-200"
                            >
                              + Add to List
                            </button>
                            <select
                              value={getQuickAddStatus(item.id)}
                              onChange={(event) =>
                                setQuickAddStatus(item.id, event.target.value as WatchStatus)
                              }
                              className="h-8 rounded-md border border-white/15 bg-[var(--bg)] px-2 text-xs text-[var(--muted)] outline-none"
                            >
                              {WATCH_STATUSES.map((status) => (
                                <option key={status} value={status}>
                                  {status}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </section>
        ) : null}

        {activeTab === "vibe" ? (
          <section className="space-y-4">
            <div className="rounded-2xl border border-white/10 bg-[var(--surface)] p-5">
              <h2 className="text-lg font-semibold">Vibe Mode</h2>
              <p className="mt-1 text-sm text-[var(--muted)]">
                Describe the mood you want and get a curated list instantly.
              </p>

              <div className="mt-4 flex flex-col gap-3 md:flex-row">
                <input
                  value={vibeQuery}
                  onChange={(event) => setVibeQuery(event.target.value)}
                  placeholder="e.g. Something like Attack on Titan but less action and more psychological"
                  className="h-12 flex-1 rounded-xl border border-[var(--secondary)]/35 bg-[var(--bg)] px-4 text-sm outline-none"
                />
                <button
                  type="button"
                  onClick={runVibeMode}
                  disabled={vibeLoading}
                  className="h-12 rounded-xl bg-[var(--secondary)] px-5 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
                >
                  {vibeLoading ? "Generating..." : "Generate Watchlist"}
                </button>
              </div>
            </div>

            {vibeResponse ? (
              <div className="space-y-3">
                <div className="rounded-xl border border-white/10 bg-[var(--surface)] p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-[var(--muted)]">
                    <span>Source: {vibeResponse.source === "gemini" ? "Gemini" : "Fallback"}</span>
                    <span>Latency: {vibeResponse.latencyMs}ms</span>
                  </div>
                  {vibeResponse.source === "fallback" && vibeResponse.fallbackReason ? (
                    <p className="mt-2 text-xs text-amber-300">
                      Fallback reason: {vibeResponse.fallbackReason}
                    </p>
                  ) : null}
                  <p className="mt-2 text-sm text-white">{vibeResponse.vibeSummary}</p>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  {vibeResponse.items.map((item) => {
                    const linkedAnime = catalog.find(
                      (anime) => normaliseTitle(anime.title) === normaliseTitle(item.title),
                    );
                    const lookedUpPoster = vibePosterByTitle[
                      normaliseTitle(item.title)
                    ];

                    return (
                    <article key={`${item.id}-${item.title}`} className="overflow-hidden rounded-xl border border-white/10 bg-[var(--surface)]">
                      <div
                        className="h-32 md:h-40"
                        style={
                          linkedAnime?.posterImageUrl
                            ? buildPosterStyle(
                                linkedAnime,
                                posterGradients[Math.abs(item.id) % posterGradients.length],
                                "cover",
                              )
                            : lookedUpPoster?.posterImageUrl
                              ? {
                                  backgroundImage: `url('${lookedUpPoster.posterImageUrl}')`,
                                  backgroundColor: "#0A0A0F",
                                  backgroundSize: "cover",
                                  backgroundPosition: "center",
                                  backgroundRepeat: "no-repeat",
                                }
                              : linkedAnime
                                ? buildPosterStyle(
                                    linkedAnime,
                                    posterGradients[Math.abs(item.id) % posterGradients.length],
                                    "cover",
                                  )
                            : {
                                background: `linear-gradient(160deg, ${lookedUpPoster?.posterColor || "#7B5EFF"} 0%, #0A0A0F 100%)`,
                              }
                        }
                      />
                      <div className="p-4">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <h3 className="font-semibold">{item.title}</h3>
                        <span className={`text-xs ${confidenceClass[item.confidence]}`}>{item.confidence}</span>
                      </div>
                      <p className="text-sm text-[var(--muted)]">{item.reason}</p>
                      <div className="mt-3 flex flex-wrap gap-1">
                        {item.tone.slice(0, 3).map((tone) => (
                          <span key={tone} className="rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-[var(--muted)]">
                            {tone}
                          </span>
                        ))}
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            ensureRecommendationTracked(item, getQuickAddStatus(item.id))
                          }
                          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white"
                        >
                          Add to List
                        </button>
                        <select
                          value={getQuickAddStatus(item.id)}
                          onChange={(event) =>
                            setQuickAddStatus(item.id, event.target.value as WatchStatus)
                          }
                          className="h-8 rounded-md border border-white/15 bg-[var(--bg)] px-2 text-xs text-[var(--muted)] outline-none"
                        >
                          {WATCH_STATUSES.map((status) => (
                            <option key={status} value={status}>
                              {status}
                            </option>
                          ))}
                        </select>
                      </div>
                      </div>
                    </article>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </section>
        ) : null}

        {activeTab === "taste" ? (
          <section className="space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
              <div className="rounded-2xl border border-white/10 bg-[var(--surface)] p-4">
                <p className="text-xs uppercase tracking-wider text-[var(--muted)]">Narrative Complexity</p>
                <p className="mt-2 text-2xl font-bold text-white">
                  {profileSummary.hasData ? `${profileSummary.complexity}/10` : "N/A"}
                </p>
                <p className="mt-2 text-sm text-[var(--muted)]">{profileSummary.narrativeSummary}</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-[var(--surface)] p-4">
                <p className="text-xs uppercase tracking-wider text-[var(--muted)]">Morality Spectrum</p>
                <p className="mt-2 text-2xl font-bold text-white">
                  {profileSummary.hasData ? `${profileSummary.morality}/10` : "N/A"}
                </p>
                <p className="mt-2 text-sm text-[var(--muted)]">{profileSummary.moralitySummary}</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-[var(--surface)] p-4">
                <p className="text-xs uppercase tracking-wider text-[var(--muted)]">Emotional Intensity</p>
                <p className="mt-2 text-2xl font-bold text-white">
                  {profileSummary.hasData ? `${profileSummary.emotionalIntensity}/10` : "N/A"}
                </p>
                <p className="mt-2 text-sm text-[var(--muted)]">{profileSummary.emotionSummary}</p>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-2xl border border-white/10 bg-[var(--surface)] p-4">
                <h3 className="text-sm font-semibold">Dominant Genres</h3>
                <div className="mt-3 h-72">
                  {profileSummary.hasData ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <RadarChart data={profileSummary.topGenres.map((item) => ({ subject: item.genre, A: item.value }))}>
                        <PolarGrid stroke="rgba(255,255,255,0.12)" />
                        <PolarAngleAxis dataKey="subject" tick={{ fill: "#A0A0C4", fontSize: 12 }} />
                        <Radar
                          name="Genre"
                          dataKey="A"
                          stroke="#FF458A"
                          fill="#FF458A"
                          fillOpacity={0.5}
                        />
                        <Tooltip
                          contentStyle={{
                            background: "#1A1F2C",
                            border: "1px solid rgba(255,255,255,0.15)",
                            borderRadius: 8,
                            color: "#FFFFFF",
                          }}
                        />
                      </RadarChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-white/15 text-sm text-[var(--muted)]">
                      No genre signal yet.
                    </div>
                  )}
                </div>
              </div>

              <div className="rounded-2xl border border-white/10 bg-[var(--surface)] p-4">
                <h3 className="text-sm font-semibold">Tone Distribution</h3>
                <div className="mt-3 h-72">
                  {profileSummary.hasData ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={profileSummary.toneDistribution}
                          dataKey="value"
                          nameKey="name"
                          innerRadius={60}
                          outerRadius={96}
                          paddingAngle={2}
                        >
                          {profileSummary.toneDistribution.map((entry) => (
                            <Cell
                              key={entry.name}
                              fill={
                                entry.name === "Dark"
                                  ? "#FF458A"
                                  : entry.name === "Emotional"
                                    ? "#7B5EFF"
                                    : entry.name === "Wholesome"
                                      ? "#4CAF50"
                                      : "#FFC107"
                              }
                            />
                          ))}
                        </Pie>
                        <Tooltip
                          contentStyle={{
                            background: "#1A1F2C",
                            border: "1px solid rgba(255,255,255,0.15)",
                            borderRadius: 8,
                            color: "#FFFFFF",
                          }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-white/15 text-sm text-[var(--muted)]">
                      No tone signal yet.
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs text-[var(--muted)]">
                  {profileSummary.toneDistribution.map((entry) => (
                    <div key={entry.name} className="rounded-md border border-white/10 px-2 py-1">
                      {entry.name}: {entry.value}%
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-[var(--accent)]/35 bg-[var(--surface)] p-4">
              <p className="inline-flex items-center gap-2 text-sm font-medium text-white">
                <Heart size={16} className="text-[var(--accent)]" />
                AniVibe Insight Narrative
              </p>
              {profileSummary.hasData ? (
                <p className="mt-2 text-sm text-[var(--muted)]">
                  Your profile favors {profileSummary.topGenres.slice(0, 2).map((item) => item.genre).join(" and ")} stories with
                  {" "}
                  {profileSummary.complexity >= 7 ? "high structural depth" : "balanced pacing"}. You respond strongly to
                  {" "}
                  {profileSummary.toneDistribution[0]?.name.toLowerCase() ?? "mixed"} tones and character-driven emotional arcs.
                </p>
              ) : (
                <p className="mt-2 text-sm text-[var(--muted)]">
                  This panel updates after you track titles. Add anime to any status list to start building your taste profile.
                </p>
              )}
            </div>
          </section>
        ) : null}
      </main>
    </div>
  );
}
