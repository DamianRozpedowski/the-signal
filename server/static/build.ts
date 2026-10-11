// Static edition builder for GitHub Pages (or any static host).
//
// One run: fetch every source that is due, read article pages, re-rank, refresh the Quick
// Reads briefing, then export what the web app needs as JSON files under <out>/data. The
// web app built with VITE_STATIC=1 reads those files instead of calling the API, and keeps
// the reader's own state (preferences, saved items, history, source and topic choices) in
// the browser. Run it on a schedule against a persistent DATABASE_PATH so stories, timelines
// and the archive build up over time.
//
//   npm run build:static && npm run static:export
//
// Environment (all optional):
//   STATIC_OUT           output folder, default ./dist (the built web app)
//   STATIC_TIMEZONE      time zone for briefing editions, default America/New_York
//   STATIC_SKIP_INGEST   1 = export only, no network
//   STATIC_FULLTEXT_MAX  article pages to read per run, default 250
//   STATIC_FULL_TEXT     1 = publish the "Full story" text taken from article pages.
//                        Off by default: a static site is public, and republishing whole
//                        articles from other publishers is not the same as reading them
//                        privately. Summaries, key facts and short quotes are kept.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

process.env.DISABLE_SCHEDULER = "1"; // no background timers; this script drives each step
process.env.DATABASE_PATH ??= path.resolve("data", "static.db");

const { openDb, closeDb, all, get, run, nowIso } = await import("../db.ts");
const { seedAll } = await import("../bootstrap.ts");
const { createApp } = await import("../app.ts");
const { DEFAULT_PREFS, savePrefs, hashPassword } = await import("../auth.ts");
const { enqueue, drain } = await import("../ingest/scheduler.ts");
const { sourcesDueForFetch } = await import("../ingest/pipeline.ts");
const { fullTextTick } = await import("../ingest/fulltext.ts");
const { rebuildIndex } = await import("../process/cluster.ts");
const { rerankRecent } = await import("../process/rank.ts");
const { generateBriefing } = await import("../briefing/generate.ts");
const { aiWorkerTick } = await import("../ai/tasks.ts");
const { config } = await import("../config.ts");
const { CATEGORIES } = await import("../process/taxonomy.ts");

const OUT = path.resolve(process.env.STATIC_OUT ?? "dist");
const DATA = path.join(OUT, "data");
const TZ = process.env.STATIC_TIMEZONE || "America/New_York";
const FULL_TEXT = process.env.STATIC_FULL_TEXT === "1";
const FULLTEXT_MAX = Number(process.env.STATIC_FULLTEXT_MAX ?? 250);
const t0 = Date.now();
const say = (msg: string) => console.log(`[static ${((Date.now() - t0) / 1000).toFixed(0)}s] ${msg}`);

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
openDb();
seedAll();
rebuildIndex();

// The edition is built for one reader who has every source on, so readers of the static
// site can switch any source on or off in their browser. Default prefs, except that every
// front-page section is exported (the browser hides the ones a reader turned off).
const EMAIL = "edition@static.invalid";
let userId = get<{ id: number }>("SELECT id FROM users WHERE email = ?", EMAIL)?.id;
if (!userId) {
  userId = Number(
    run(
      "INSERT INTO users (email, display_name, password_hash, is_admin, timezone, created_at) VALUES (?, 'Edition', ?, 0, ?, ?)",
      EMAIL, hashPassword(crypto.randomBytes(24).toString("hex")), TZ, nowIso(),
    ).lastInsertRowid,
  );
}
run("UPDATE users SET timezone = ? WHERE id = ?", TZ, userId);
for (const { id } of all<{ id: number }>("SELECT id FROM sources WHERE admin_disabled = 0")) {
  run("INSERT INTO user_sources (user_id, source_id, enabled) VALUES (?, ?, 1) ON CONFLICT(user_id, source_id) DO UPDATE SET enabled = 1", userId, id);
}
savePrefs(userId, {
  homepage: { ...DEFAULT_PREFS.homepage, topCount: 14, sections: DEFAULT_PREFS.homepage.sections.map((s) => ({ ...s, enabled: true, count: 10 })) },
});

// ---- 1. Refresh the data ----------------------------------------------------------------

if (process.env.STATIC_SKIP_INGEST !== "1") {
  const due = sourcesDueForFetch(1000);
  say(`Fetching ${due.length} sources`);
  for (const { id } of due) enqueue(id, "schedule");
  await drain(15 * 60_000);
  const failed = get<{ n: number }>("SELECT COUNT(*) AS n FROM sources WHERE status IN ('error', 'degraded') AND admin_disabled = 0")!.n;
  say(`Sources done (${failed} failing)`);

  // Read article pages for the stories that matter, within a time budget.
  let read = 0;
  const pending = () =>
    get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM articles a JOIN clusters c ON c.id = a.cluster_id
       WHERE a.page_status IS NULL AND a.published_at >= ? AND (c.source_count >= 2 OR c.importance >= 40)`,
      new Date(Date.now() - 72 * 3600_000).toISOString(),
    )!.n;
  const budgetEnd = Date.now() + 10 * 60_000;
  for (let i = 0; i < Math.ceil(FULLTEXT_MAX / 20) && Date.now() < budgetEnd && pending() > 0; i++) {
    read += (await fullTextTick(20)).fetched;
  }
  say(`Read ${read} article pages`);

  rerankRecent();
  if (config.anthropicKeyPresent && !config.aiDisabled) {
    for (let i = 0; i < 5; i++) await aiWorkerTick(6).catch((e: any) => say(`AI step failed: ${e?.message}`));
  }
  await generateBriefing(userId).catch((e: any) => say(`Briefing failed: ${e?.message}`));
}

// ---- 2. Export ------------------------------------------------------------------------

const token = crypto.randomBytes(32).toString("base64url");
run(
  "INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, 'static-export')",
  crypto.createHash("sha256").update(token).digest("hex"), userId, nowIso(), new Date(Date.now() + 3600_000).toISOString(),
);
const server = createApp().listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;

async function api(url: string): Promise<any> {
  const res = await fetch(base + url, { headers: { cookie: `dw_session=${token}` } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

fs.rmSync(DATA, { recursive: true, force: true });
let files = 0;
let bytes = 0;
function write(rel: string, data: unknown) {
  const file = path.join(DATA, `${rel}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify(data);
  fs.writeFileSync(file, body);
  files++;
  bytes += body.length;
}

const storyIds = new Set<number>();
const addCards = (cards: any[] | undefined | null) => cards?.forEach((c) => c?.id && storyIds.add(c.id));

const status = await api("/api/system/status");
write("system/status", status);
write("prefs", { defaults: DEFAULT_PREFS });
write("categories", await api("/api/categories"));

const today = await api("/api/today");
write("today", today);
addCards([today.lead, ...today.top, ...today.breaking, ...today.sections.flatMap((s: any) => s.stories)]);
addCards([...today.sidebar.developing, ...today.sidebar.recentlyUpdated]);

const live = await api("/api/live?hours=48");
write("live", live);
live.entries.forEach((e: any) => storyIds.add(e.clusterId));

// Sections: every story of the last three days, capped, in importance order.
for (const c of CATEGORIES) {
  const first = await api(`/api/category/${c.key}`);
  const stories = [...first.stories];
  for (let page = 2; stories.length < Math.min(first.total, 150); page++) {
    const next = await api(`/api/category/${c.key}?page=${page}`);
    if (!next.stories.length) break;
    stories.push(...next.stories);
  }
  write(`category/${c.key}`, { ...first, stories: stories.slice(0, 150), total: Math.min(first.total, 150), page: 1 });
  addCards(stories.slice(0, 150));
}

const topics = await api("/api/topics");
write("topics", topics);
for (const t of topics.topics) {
  const d = await api(`/api/topics/${t.id}`);
  write(`topics/${t.id}`, d);
  addCards([...d.top, ...d.recent]);
}

const current = await api("/api/briefing/current");
write("briefing/current", current);
const briefings = await api("/api/briefings");
const weekAgo = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
const recentEditions = briefings.editions.filter((e: any) => e.editionDate >= weekAgo);
write("briefings", { editions: recentEditions });
for (const e of recentEditions) {
  for (const r of e.revisions) {
    const b = await api(`/api/briefing/${r.id}`);
    write(`briefing/${r.id}`, b);
    b.briefing?.content?.stories?.forEach((s: any) => s.clusterId && storyIds.add(s.clusterId));
  }
}
current.briefing?.content?.stories?.forEach((s: any) => s.clusterId && storyIds.add(s.clusterId));

// Archive: the last 30 days.
const days: { day: string; n: number }[] = [];
for (let i = 0; i < 30; i++) {
  const date = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
  const a = await api(`/api/archive?date=${date}`);
  if (i === 0) days.push(...a.days.filter((d: any) => d.day >= new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)));
  if (!a.stories.length && !a.briefings.length) continue;
  write(`archive/${date}`, { ...a, days: undefined });
  addCards(a.stories);
}
write("archive/days", { days });

write("weekly", await api("/api/weekly").catch(() => ({ status: "unavailable" })));
write("upcoming", await api("/api/upcoming"));

const sources = await api("/api/sources");
write("sources", sources);
for (const s of sources.sources) write(`sources/detail/${s.id}`, await api(`/api/sources/${s.id}/detail`));
write("sources/diversity", await api("/api/sources/diversity"));

// Stories, and the articles in them. Related-story links stay inside the exported set.
const articleIds = new Set<number>();
let n = 0;
for (const id of storyIds) {
  const d = await api(`/api/story/${id}?visit=0`).catch(() => null);
  if (!d || d.hidden) {
    storyIds.delete(id);
    continue;
  }
  d.related = (d.related ?? []).filter((r: any) => storyIds.has(r.id));
  d.following = false;
  d.saved = false;
  d.sinceLastVisit = null;
  if (!FULL_TEXT && d.extracted) d.extracted = { ...d.extracted, story: [], storyOmitted: d.extracted.story?.length > 0 };
  write(`story/${id}`, d);
  d.articles.forEach((a: any) => articleIds.add(a.id));
  if (++n % 200 === 0) say(`Exported ${n} stories`);
}
for (const id of articleIds) {
  const a = await api(`/api/article/${id}?visit=0`).catch(() => null);
  if (!a) continue;
  if (!FULL_TEXT) a.content = null;
  a.saved = false;
  a.readLater = false;
  write(`article/${id}`, a);
}

// Search runs in the browser over the exported articles.
const idList = [...articleIds];
const searchRows: any[] = [];
for (let i = 0; i < idList.length; i += 500) {
  const chunk = idList.slice(i, i + 500);
  searchRows.push(
    ...all<any>(
      `SELECT a.id, a.headline, a.description, a.canonical_url, a.published_at, a.category, a.article_type, a.cluster_id, a.link_status, a.topics, a.geo,
              s.name AS source_name, s.id AS source_id, c.importance, c.article_count AS cluster_size
       FROM articles a JOIN sources s ON s.id = a.source_id LEFT JOIN clusters c ON c.id = a.cluster_id
       WHERE a.id IN (${chunk.map(() => "?").join(",")})`,
      ...chunk,
    ),
  );
}
write("search-index", {
  articles: searchRows
    .sort((a, b) => b.published_at.localeCompare(a.published_at))
    .map((r) => [r.id, r.headline, (r.description ?? "").slice(0, 400), r.canonical_url, r.published_at, r.category, r.article_type, r.cluster_id, r.source_id, r.source_name, r.importance ?? 0, r.cluster_size ?? 1, JSON.parse(r.topics || "[]"), JSON.parse(r.geo || "[]"), r.link_status]),
});

const generatedAt = nowIso();
write("meta", { generatedAt, version: crypto.createHash("sha1").update(generatedAt).digest("hex").slice(0, 10), timezone: TZ, fullText: FULL_TEXT, stories: storyIds.size, articles: articleIds.size, ai: config.anthropicKeyPresent });

server.close();
run("DELETE FROM sessions WHERE user_agent = 'static-export'");

// Single-page app on a static host: unknown paths serve the app, which routes client-side.
const index = path.join(OUT, "index.html");
if (fs.existsSync(index)) fs.copyFileSync(index, path.join(OUT, "404.html"));
fs.writeFileSync(path.join(OUT, ".nojekyll"), "");

closeDb(); // checkpoints the WAL so the database is one file for the next run

say(`Wrote ${files} files (${(bytes / 1048576).toFixed(1)} MB): ${storyIds.size} stories, ${articleIds.size} articles`);
process.exit(0);
