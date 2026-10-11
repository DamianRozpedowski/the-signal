# The Signal

A personalized, always-updating digital newspaper. It collects articles from real RSS, Atom, RDF and JSON Feed sources, removes duplicates, groups reports about the same event into stories, ranks them with explainable signals, and presents them as a front page, Quick Reads briefings (2, 5 and 10 minutes), a Live News stream, sections, topics, search and an archive.

Nothing in the app is mock data. With no sources enabled, or before the first fetch, pages say so. Features that need a credential (AI, email, push) show a configuration notice instead of pretending to work.

## Quick start

Requirements: Node.js 22.13 or newer (uses the built-in `node:sqlite`) and outbound HTTPS access to the news feeds you enable.

```bash
npm install
npm run build          # builds the web app into dist/
cp .env.example .env   # optional: add ANTHROPIC_API_KEY, SMTP_*, VAPID_*
npm start              # serves the app and API on http://localhost:8787
```

Open the app, create the first account (it becomes the administrator), and the default sources start fetching right away. Stories appear as feeds arrive; the page updates live.

For development, `npm run dev` runs the API with reload on port 8787 and the Vite dev server on port 5173 (proxying `/api`).

```bash
npm test          # pipeline tests against local fixture feeds
npm run typecheck
```

## Configuration

All settings are environment variables; see [.env.example](.env.example). `npm start` loads `.env` automatically when present.

| Variable | Purpose |
| --- | --- |
| `PORT`, `DATA_DIR`, `DATABASE_PATH` | Server port and where the SQLite database lives (default `./data/daily-wire.db`). |
| `PUBLIC_URL` | Public address, used for links in email and push alerts. |
| `ALLOW_SIGNUP` | `1` lets new readers create accounts. Otherwise only the first (admin) account can be created. |
| `ANTHROPIC_API_KEY` | Enables AI summaries, story synthesis and coverage comparison, briefing prose, event extraction, grounded Q&A and weekly recaps. Without it the app works fully but shows publisher descriptions and a notice. |
| `AI_MODEL`, `AI_ARTICLE_MODEL` | Model ids (default `claude-opus-5-5`). |
| `AI_DAILY_ARTICLE_SUMMARY_LIMIT` | Daily cap on per-article summaries (default 400). Story-level syntheses are not capped. |
| `AI_DISABLED`, `AI_FALLBACKS` | Turn AI off; disable server-side model fallback. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Email alerts. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push alerts. Generate keys with `npx web-push generate-vapid-keys`. |
| `INGEST_CONCURRENCY`, `FETCH_TIMEOUT_MS`, `MAX_FEED_BYTES`, `MIN_HOST_INTERVAL_MS`, `FEED_USER_AGENT` | Ingestion tuning. Set a user agent with a contact URL in production. |
| `DISABLE_SCHEDULER` | Stops automatic fetching. |
| `ALLOW_PRIVATE_FEEDS` | Development only: allows feeds on localhost or private networks (turns off the SSRF guard). |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` | Honored for feed and API requests. |

API keys are read only on the server. They are never sent to the browser, written to logs, or included in AI prompts.

## Deployment

The app is a single Node process (API, scheduler and static web app) with an embedded SQLite database, so it suits one small VM or container with a persistent volume.

1. `npm ci && npm run build`
2. Set environment variables (at least a persistent `DATA_DIR`, plus `PUBLIC_URL`, and the optional credentials).
3. Run `npm start` under a process manager (systemd, Docker, Fly, Render…), behind HTTPS. The session cookie is `HttpOnly`, `SameSite=Lax` and `Secure` when `PUBLIC_URL` is https.
4. Back up `DATA_DIR` (the `.db` file plus its `-wal` file). Health check: `GET /api/health`.

The outbound network must allow HTTPS to the feed hosts you enable and to `api.anthropic.com` if AI is configured.

## Online edition (GitHub Pages)

A read-only edition can be published to GitHub Pages and refreshed every hour by GitHub Actions ([.github/workflows/pages.yml](.github/workflows/pages.yml)). Each run restores the database from the previous run, fetches the feeds, reads article pages, updates the Quick Reads briefing and exports everything the app needs as JSON. The web app built with `npm run build:static` reads those files instead of the API.

To turn it on: Settings → Pages → Source: **GitHub Actions**. Pages needs a public repository (or a paid plan for a private one), and a published Pages site is visible to anyone with the link.

In the online edition, settings, source and topic choices, saved stories, saved searches and reading history are stored in the reader's browser. Accounts, alerts, adding new sources, AI questions and on-demand refreshes need the full version above. Story pages show the summary, key facts and quotes with links to the original articles; set the repository variable `SIGNAL_FULL_TEXT=1` to also publish the full article text (only do this if you are comfortable republishing it publicly). Other options: `SIGNAL_TIMEZONE` (edition times, default America/New_York) and the `ANTHROPIC_API_KEY` secret.

To build it locally: `npm run build:static && npm run static:export` writes the site to `dist/` (set `STATIC_SKIP_INGEST=1` to export without fetching).

## How it works

- **Ingestion** (`server/ingest`): per-source schedules with adaptive intervals, conditional requests (ETag / Last-Modified), robots.txt checks, size and time limits, redirect and charset handling, SSRF protection, exponential backoff that honors `Retry-After`. Every run is recorded as a job. Failures are visible to readers (source health) and admins.
- **Processing** (`server/process`): URL canonicalization, duplicate detection (source URL/GUID, cross-source URL, near-identical title, content fingerprint), change detection with revisions and correction/retraction flags, classification into sections, topics, places and article types.
- **Stories**: TF-IDF and entity similarity within a time window group reports about the same event; syndicated copies are counted once when measuring independent coverage. Each story keeps a timeline of first report, updates, official statements and corrections.
- **Ranking** (`server/process/rank.ts`): bounded, labeled signals (coverage breadth, impact, official sources, development, recency, hard news, opinion penalty). Every story shows why it ranks where it does. Weights are adjustable in Admin → Ranking. Personalization (followed and muted topics, area, source priority) is applied per reader with a strength setting, and the most significant stories always stay on the front page.
- **AI** (`server/ai`): structured output; source material is wrapped and marked untrusted so instructions inside articles are ignored; facts must cite source articles; sentences containing numbers not present in the sources are removed; failures are logged and shown, never hidden.
- **Briefings** (`server/briefing`): morning and evening editions per reader time zone. They regenerate only on material change, and every revision is kept. Ranked stories, overnight changes, what changed and what to watch are produced without AI; AI adds prose when configured.
- **Notifications** (`server/notify`): breaking news, followed stories, topics, keywords and saved searches, sources, upcoming events and new briefings. Alerts are deduplicated, respect quiet hours and hourly limits, and record a per-channel delivery status (in-app, browser, email, push).

## Limitations

- Feeds usually carry headlines and short excerpts. Summaries say when they are based on excerpts only. Full article text is never scraped; readers are sent to the original.
- Single-process SQLite: suitable for personal or small-team use. Horizontal scaling would need a shared database and job queue.
- Some catalog feeds may move or change format over time; they show up as failing in Sources and Admin, and admins can edit the feed URL.
- Web Push needs HTTPS (or localhost) and VAPID keys. Browser notifications work only while the app is open in a tab.
- Local news depends on enabling local outlets (Sources → Local) and choosing a coverage area.
- Upcoming events are extracted from coverage only when AI is configured; readers can also add their own.
