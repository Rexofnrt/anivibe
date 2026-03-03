# AniVibe Web App (MVP)

AniVibe is a dark-mode, key-art driven anime tracker with AI-powered recommendations, Vibe Mode, and taste insights.

## Stack

- Next.js 16 (App Router) + React 19 + TypeScript
- Tailwind CSS v4
- Recharts for Taste Insights visualizations
- Gemini API integration via server routes
- AniList GraphQL search integration

## Setup

1. Install dependencies:

```bash
npm install
```

2. Configure secrets in `.env.local`:

```bash
GEMINI_API_KEY=your_key_here
ANILIST_CLIENT_ID=your_anilist_client_id
ANILIST_CLIENT_SECRET=your_anilist_client_secret
ANILIST_REDIRECT_URI=http://localhost:3000/api/auth/anilist/callback
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_GEMINI_READY=Configured via .env.local
```

3. Run development server:

```bash
npm run dev
```

4. Open http://localhost:3000

## Implemented MVP Features

- Smart tracking lists: Watching, Completed, On-Hold, Plan-to-Watch
- Progress monitoring and completed-title rating/review
- AI recommendations endpoint with hidden-gem inclusion + fallback logic
- Vibe Mode natural language query endpoint with fallback logic
- AniList title search + add-to-watchlist
- Taste Insights dashboard: genre radar + tone distribution + narrative summaries
- Local feedback loop with 👍 / 👎 capture for recalibration

## API Routes

- `GET /api/anilist/search?q=...`
- `POST /api/gemini/recommendations`
- `POST /api/gemini/vibe`
