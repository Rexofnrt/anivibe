import { NextRequest, NextResponse } from "next/server";

const query = `
  query ($search: String) {
    Page(page: 1, perPage: 50) {
      media(search: $search, type: ANIME, sort: POPULARITY_DESC) {
        id
        title {
          romaji
          english
        }
        genres
        episodes
        averageScore
        description(asHtml: false)
        bannerImage
        coverImage {
          color
          medium
          large
          extraLarge
        }
      }
    }
  }
`;

export async function GET(request: NextRequest) {
  const search = request.nextUrl.searchParams.get("q")?.trim();

  if (!search) {
    return NextResponse.json({ items: [] });
  }

  try {
    const response = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query, variables: { search } }),
      cache: "no-store",
    });

    if (!response.ok) {
      return NextResponse.json(
        { items: [], error: "AniList request failed" },
        { status: 502 },
      );
    }

    const payload = (await response.json()) as {
      data?: {
        Page?: {
          media?: Array<{
            id: number;
            title: { romaji: string | null; english: string | null };
            genres: string[];
            episodes: number | null;
            averageScore: number | null;
            description: string | null;
            bannerImage: string | null;
            coverImage: {
              color: string | null;
              medium: string | null;
              large: string | null;
              extraLarge: string | null;
            } | null;
          }>;
        };
      };
    };

    const items = (payload.data?.Page?.media ?? []).map((anime) => ({
      id: anime.id,
      title: anime.title.english ?? anime.title.romaji ?? "Untitled",
      genres: anime.genres ?? [],
      episodes: anime.episodes ?? 12,
      synopsis: (anime.description ?? "No synopsis available.").replace(/<[^>]*>/g, ""),
      popularity: anime.averageScore ?? 60,
      posterColor: anime.coverImage?.color ?? "#7B5EFF",
      posterImageUrl:
        anime.coverImage?.extraLarge ??
        anime.coverImage?.large ??
        anime.coverImage?.medium ??
        anime.bannerImage ??
        null,
    }));

    return NextResponse.json({ items });
  } catch {
    return NextResponse.json(
      { items: [], error: "Unable to reach AniList right now." },
      { status: 500 },
    );
  }
}
