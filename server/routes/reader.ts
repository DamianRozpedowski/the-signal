import { Router } from "express";
import { z } from "zod";
import { DEFAULT_PREFS, getPrefs, requireUser, resetPrefs, savePrefs } from "../auth.ts";
import { askQuestion, topicTrends, weeklyRecap } from "../ai/advanced.ts";
import { aiStatusDetail } from "../ai/provider.ts";
import { summarizeArticle, summarizeCluster } from "../ai/tasks.ts";
import { generateBriefing, regenerateEdition } from "../briefing/generate.ts";
import { all, get, json, nowIso, parseJson, run } from "../db.ts";
import { chooseLead, lastRefresh, sourceHealthFor, storiesFor, userContext, type StoryCard } from "../edition.ts";
import { channelStatus, sendTestNotification } from "../notify/engine.ts";
import { CATEGORIES, categoryLabel } from "../process/taxonomy.ts";
import { backfillTopic, invalidateTopics } from "../process/topics.ts";
import { search } from "../search.ts";
import { articleDetail, storyDetail } from "../story.ts";
import { aiStatus } from "../ai/provider.ts";
import { HttpError, asyncH, intParam, parseBody, qint, qstr } from "./util.ts";

export const reader = Router();
reader.use(requireUser);

const uid = (req: any) => req.user.id as number;

// ---- Preferences ------------------------------------------------------------------------

reader.get("/prefs", (req, res) => res.json({ prefs: getPrefs(uid(req)), defaults: DEFAULT_PREFS }));
reader.put(
  "/prefs",
  asyncH((req, res) => {
    const body = req.body ?? {};
    if (typeof body !== "object") throw new HttpError(400, "Invalid preferences");
    if (body.personalization !== undefined) body.personalization = Math.max(0, Math.min(100, Number(body.personalization) || 0));
    if (body.notifications?.maxPerHour !== undefined) body.notifications.maxPerHour = Math.max(1, Math.min(60, Number(body.notifications.maxPerHour) || 4));
    if (body.homepage?.sections) {
      body.homepage.sections = (body.homepage.sections as any[])
        .filter((s) => CATEGORIES.some((c) => c.key === s.key))
        .map((s) => ({ key: s.key, enabled: Boolean(s.enabled), count: Math.max(1, Math.min(12, Number(s.count) || 4)) }));
    }
    res.json({ prefs: savePrefs(uid(req), body) });
  }),
);
reader.post("/prefs/reset", (req, res) => res.json({ prefs: resetPrefs(uid(req)) }));

// ---- Today (homepage) ---------------------------------------------------------------------

function mostRead(ctx: ReturnType<typeof userContext>) {
  const rows = all<{ target_id: number; n: number }>(
    `SELECT target_id, COUNT(DISTINCT user_id) * 3 + COUNT(*) AS n FROM reading_history
     WHERE target_type = 'story' AND at >= ? GROUP BY target_id ORDER BY n DESC LIMIT 20`,
    new Date(Date.now() - 24 * 3600_000).toISOString(),
  );
  const cards = storiesFor(ctx, { clusterIds: rows.map((r) => r.target_id), includeMuted: false });
  return rows.map((r) => ({ card: cards.find((c) => c.id === r.target_id), reads: r.n })).filter((x) => x.card).slice(0, 5);
}

reader.get(
  "/today",
  asyncH((req, res) => {
    const userId = uid(req);
    const ctx = userContext(userId);
    const prefs = ctx.prefs;
    const ranked = storiesFor(ctx, { sinceHours: 48 });
    const lead = chooseLead(userId, ranked);
    const used = new Set<number>(lead ? [lead.id] : []);

    // Preserve a core of the most significant stories regardless of personalization.
    const coreByBase = [...ranked].sort((a, b) => b.baseImportance - a.baseImportance).slice(0, 4);
    const top: StoryCard[] = [];
    for (const s of [...coreByBase, ...ranked]) {
      if (top.length >= prefs.homepage.topCount) break;
      if (used.has(s.id) || s.lead.articleType === "opinion") continue;
      top.push(s);
      used.add(s.id);
    }
    top.sort((a, b) => b.importance - a.importance);
    const breaking = ranked.filter((s) => s.isBreaking).slice(0, 4);

    const sections = prefs.homepage.sections
      .filter((s) => s.enabled)
      .map((sec) => {
        let stories: StoryCard[];
        if (sec.key === "local") {
          stories = prefs.location
            ? ranked.filter((s) => s.geo.some((g) => g === prefs.location!.code || g.startsWith(`${prefs.location!.code}-`)) || s.category === "local")
            : ranked.filter((s) => s.category === "local");
        } else stories = ranked.filter((s) => s.category === sec.key);
        const total = stories.length;
        stories = stories.filter((s) => !used.has(s.id)).slice(0, sec.count);
        stories.forEach((s) => used.add(s.id));
        return { key: sec.key, label: sec.key === "local" && prefs.location ? `Local: ${prefs.location.label}` : categoryLabel(sec.key), stories, total };
      });

    const followedTopics = all<any>(
      "SELECT t.id, t.name, t.slug FROM user_topics ut JOIN topics t ON t.id = ut.topic_id WHERE ut.user_id = ? AND ut.state = 'follow'",
      userId,
    ).map((t) => ({ ...t, count: ranked.filter((s) => s.topics.includes(t.id)).length }));

    const latestBriefing = get<any>("SELECT id, generated_at, content, edition, edition_date, status FROM briefings WHERE user_id = ? ORDER BY generated_at DESC LIMIT 1", userId);
    const bc = latestBriefing ? parseJson<any>(latestBriefing.content, null) : null;
    const health = sourceHealthFor(userId);
    res.json({
      generatedAt: nowIso(),
      refresh: lastRefresh(),
      health,
      ai: aiStatusDetail(),
      lead,
      top,
      breaking,
      sections,
      sidebar: {
        mostRead: mostRead(ctx),
        developing: ranked.filter((s) => s.status === "developing" && !s.isBreaking).slice(0, 6),
        recentlyUpdated: [...ranked].sort((a, b) => b.lastUpdateAt.localeCompare(a.lastUpdateAt)).slice(0, 6),
        followedTopics,
        upcoming: all<any>(
          "SELECT * FROM upcoming_events WHERE (created_by IS NULL OR created_by = ?) AND starts_at >= ? ORDER BY starts_at LIMIT 5",
          userId, nowIso(),
        ),
        quickReads: latestBriefing
          ? {
              id: latestBriefing.id,
              generatedAt: latestBriefing.generated_at,
              edition: bc?.editionLabel,
              bigPicture: bc?.bigPicture?.text ?? "",
              headlines: (bc?.stories ?? []).slice(0, 4).map((s: any) => ({ clusterId: s.clusterId, headline: s.headline })),
            }
          : null,
      },
      totals: { stories: ranked.length },
    });
  }),
);

// ---- Category, local, live -----------------------------------------------------------

reader.get(
  "/category/:key",
  asyncH((req, res) => {
    const key = String(req.params.key);
    if (!CATEGORIES.some((c) => c.key === key)) throw new HttpError(404, "Unknown category");
    const ctx = userContext(uid(req));
    const hours = Math.min(24 * 14, qint(req.query.hours) ?? 72);
    const sort = req.query.sort === "latest" ? "latest" : "importance";
    let stories = storiesFor(ctx, { sinceHours: hours, category: key === "local" ? undefined : key, sourceId: qint(req.query.source), sort, limit: 400 });
    if (key === "local") {
      const code = qstr(req.query.geo) ?? ctx.prefs.location?.code;
      stories = stories.filter((s) => s.category === "local" || (code && s.geo.some((g) => g === code || g.startsWith(`${code}-`))));
    }
    const q = qstr(req.query.q)?.toLowerCase();
    if (q) stories = stories.filter((s) => `${s.headline} ${s.description ?? ""}`.toLowerCase().includes(q));
    if (req.query.status === "developing") stories = stories.filter((s) => s.status === "developing");
    const page = Math.max(1, qint(req.query.page) ?? 1);
    const pageSize = 20;
    res.json({
      key,
      label: categoryLabel(key),
      location: key === "local" ? ctx.prefs.location : undefined,
      total: stories.length,
      page,
      pageSize,
      stories: stories.slice((page - 1) * pageSize, page * pageSize),
      sources: all<any>(
        `SELECT DISTINCT s.id, s.name FROM sources s WHERE s.id IN (${[...ctx.active].map(() => "?").join(",") || "NULL"}) ORDER BY s.name`,
        ...ctx.active,
      ),
    });
  }),
);

reader.get(
  "/live",
  asyncH((req, res) => {
    const userId = uid(req);
    const ctx = userContext(userId);
    const hours = Math.min(72, qint(req.query.hours) ?? 24);
    const since = new Date(Date.now() - hours * 3600_000).toISOString();
    const after = qstr(req.query.after); // ISO timestamp: only entries observed after this
    const filter = qstr(req.query.filter) ?? "all";
    const category = qstr(req.query.category);
    const sourceId = qint(req.query.source);
    const view = req.query.view === "importance" ? "importance" : "chronological";
    const active = [...ctx.active];
    if (!active.length) return res.json({ entries: [], serverTime: nowIso() });

    // Live entries: new stories (first report) and meaningful developments, never every article.
    const events = all<any>(
      `SELECT e.id, e.cluster_id, e.kind, e.text, e.at, e.observed_at, e.significant, e.article_id,
              a.headline, a.description, a.canonical_url, a.published_at, a.retrieved_at, a.source_id, a.article_type, s.name AS source_name
       FROM cluster_events e JOIN articles a ON a.id = e.article_id JOIN sources s ON s.id = a.source_id
       WHERE e.observed_at >= ? ${after ? "AND e.observed_at > ?" : ""} AND (e.significant = 1 OR e.kind = 'new_source')
         AND a.source_id IN (${active.map(() => "?").join(",")})
       ORDER BY e.observed_at DESC LIMIT 400`,
      since, ...(after ? [after] : []), ...active,
    );
    const clusterIds = [...new Set(events.map((e) => e.cluster_id))];
    const cards = new Map(storiesFor(ctx, { clusterIds, includeMuted: false }).map((c) => [c.id, c]));
    let entries = events
      .filter((e) => cards.has(e.cluster_id))
      .map((e) => {
        const card = cards.get(e.cluster_id)!;
        return {
          id: e.id,
          clusterId: e.cluster_id,
          kind: e.kind,
          isNewStory: e.kind === "first_report",
          isSignificantUpdate: Boolean(e.significant) && e.kind !== "first_report",
          text: e.text,
          headline: e.headline,
          description: e.description,
          url: e.canonical_url,
          articleId: e.article_id,
          sourceName: e.source_name,
          sourceId: e.source_id,
          publishedAt: e.published_at,
          retrievedAt: e.retrieved_at,
          observedAt: e.observed_at,
          category: card.category,
          categoryLabel: card.categoryLabel,
          importance: card.importance,
          isBreaking: card.isBreaking,
          status: card.status,
          topics: card.topics,
          storyHeadline: card.headline,
          sourceCount: card.sourceCount,
        };
      });
    // "Also reports" entries are collapsed: only kept when the reader filters to a single source.
    if (!sourceId) entries = entries.filter((e) => e.kind !== "new_source");
    if (filter === "breaking") entries = entries.filter((e) => e.isBreaking);
    if (filter === "developing") entries = entries.filter((e) => e.status === "developing");
    if (filter === "followed") entries = entries.filter((e) => e.topics.some((t) => ctx.followed.has(t)));
    if (category) entries = entries.filter((e) => e.category === category);
    if (sourceId) entries = entries.filter((e) => e.sourceId === sourceId);
    if (view === "importance") entries.sort((a, b) => b.importance - a.importance);
    res.json({ entries: entries.slice(0, 150), serverTime: nowIso(), refresh: lastRefresh() });
  }),
);

// ---- Story and article ---------------------------------------------------------------

reader.get(
  "/story/:id",
  asyncH((req, res) => {
    const d = storyDetail(uid(req), intParam(req.params.id), { recordVisit: req.query.visit !== "0" });
    if (!d) throw new HttpError(404, "Story not found");
    res.json(d);
  }),
);

reader.post(
  "/story/:id/summarize",
  asyncH(async (req, res) => {
    const r = await summarizeCluster(intParam(req.params.id), { force: true });
    res.json(r);
  }),
);

reader.get(
  "/article/:id",
  asyncH((req, res) => {
    const d = articleDetail(uid(req), intParam(req.params.id), { recordVisit: req.query.visit !== "0" });
    if (!d) throw new HttpError(404, "Article not found");
    res.json(d);
  }),
);

reader.post(
  "/article/:id/summarize",
  asyncH(async (req, res) => {
    res.json(await summarizeArticle(intParam(req.params.id)));
  }),
);

// ---- Quick Reads ---------------------------------------------------------------------

function briefingPayload(b: any) {
  return {
    id: b.id,
    editionDate: b.edition_date,
    edition: b.edition,
    timezone: b.timezone,
    windowStart: b.window_start,
    windowEnd: b.window_end,
    generatedAt: b.generated_at,
    dataRefreshedAt: b.data_refreshed_at,
    status: b.status,
    revision: b.revision,
    supersedesId: b.supersedes_id,
    revisionReason: b.revision_reason,
    aiStatus: b.ai_status,
    aiModel: b.ai_model,
    content: parseJson(b.content, null),
  };
}

reader.get(
  "/briefing/current",
  asyncH(async (req, res) => {
    const userId = uid(req);
    await generateBriefing(userId); // no-op unless material change / new edition
    const b = get<any>("SELECT * FROM briefings WHERE user_id = ? ORDER BY generated_at DESC, revision DESC LIMIT 1", userId);
    res.json({ briefing: b ? briefingPayload(b) : null, refresh: lastRefresh(), ai: aiStatusDetail() });
  }),
);

reader.post(
  "/briefing/refresh",
  asyncH(async (req, res) => {
    const r = await generateBriefing(uid(req), { force: true, reason: "manual" });
    const b = get<any>("SELECT * FROM briefings WHERE id = ?", r.briefingId);
    res.json({ briefing: briefingPayload(b), result: r });
  }),
);

reader.get(
  "/briefings",
  asyncH((req, res) => {
    const rows = all<any>(
      `SELECT b.id, b.edition_date, b.edition, b.generated_at, b.status, b.revision, b.revision_reason, b.ai_status, json_array_length(b.story_ids) AS stories
       FROM briefings b WHERE b.user_id = ? ORDER BY b.edition_date DESC, b.edition DESC, b.revision DESC LIMIT 500`,
      uid(req),
    );
    // Group revisions under their edition.
    const editions = new Map<string, any>();
    for (const r of rows) {
      const k = `${r.edition_date}|${r.edition}`;
      if (!editions.has(k)) editions.set(k, { editionDate: r.edition_date, edition: r.edition, latest: r, revisions: [] });
      editions.get(k).revisions.push(r);
    }
    res.json({ editions: [...editions.values()] });
  }),
);

reader.get(
  "/briefing/:id",
  asyncH((req, res) => {
    const b = get<any>("SELECT * FROM briefings WHERE id = ? AND user_id = ?", intParam(req.params.id), uid(req));
    if (!b) throw new HttpError(404, "Briefing not found");
    const revisions = all<any>(
      "SELECT id, revision, generated_at, revision_reason, status FROM briefings WHERE user_id = ? AND edition_date = ? AND edition = ? ORDER BY revision",
      uid(req), b.edition_date, b.edition,
    );
    res.json({ briefing: briefingPayload(b), revisions });
  }),
);

reader.post(
  "/briefing/:id/regenerate",
  asyncH(async (req, res) => {
    const b = get<any>("SELECT id FROM briefings WHERE id = ? AND user_id = ?", intParam(req.params.id), uid(req));
    if (!b) throw new HttpError(404, "Briefing not found");
    res.json(await regenerateEdition(b.id));
  }),
);

// ---- Archive ---------------------------------------------------------------------------

reader.get(
  "/archive",
  asyncH((req, res) => {
    const userId = uid(req);
    const date = qstr(req.query.date) ?? new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, "Invalid date");
    const start = new Date(`${date}T00:00:00Z`).toISOString();
    const end = new Date(Date.parse(start) + 86_400_000).toISOString();
    const ctx = userContext(userId);
    const active = [...ctx.active];
    const clusterIds = active.length
      ? all<{ id: number }>(
          `SELECT DISTINCT a.cluster_id AS id FROM articles a WHERE a.published_at >= ? AND a.published_at < ? AND a.cluster_id IS NOT NULL
           AND a.source_id IN (${active.map(() => "?").join(",")})`,
          start, end, ...active,
        ).map((r) => r.id)
      : [];
    const stories = storiesFor(ctx, { clusterIds, includeMuted: true }).slice(0, 40);
    const briefings = all<any>(
      "SELECT id, edition, generated_at, status, revision, revision_reason FROM briefings WHERE user_id = ? AND edition_date = ? ORDER BY edition, revision",
      userId, date,
    );
    const days = all<{ day: string; n: number }>(
      `SELECT substr(published_at, 1, 10) AS day, COUNT(*) AS n FROM articles WHERE published_at >= ? GROUP BY day ORDER BY day DESC`,
      new Date(Date.now() - 120 * 86_400_000).toISOString(),
    );
    const pastEvents = all<any>("SELECT * FROM upcoming_events WHERE starts_at >= ? AND starts_at < ? ORDER BY starts_at", start, end);
    res.json({ date, stories, briefings, days, pastEvents });
  }),
);

// ---- Search -------------------------------------------------------------------------

reader.get(
  "/search",
  asyncH((req, res) => {
    const sourceIds = qstr(req.query.sources)?.split(",").map(Number).filter(Number.isFinite);
    res.json(
      search(uid(req), {
        q: qstr(req.query.q) ?? "",
        sourceIds,
        category: qstr(req.query.category),
        topicId: qint(req.query.topic),
        from: qstr(req.query.from),
        to: qstr(req.query.to),
        geo: qstr(req.query.geo),
        type: qstr(req.query.type),
        sort: (qstr(req.query.sort) as any) ?? "relevance",
        page: qint(req.query.page),
        expand: req.query.expand !== "0",
      }),
    );
  }),
);

reader.get("/saved-searches", (req, res) =>
  res.json({ items: all<any>("SELECT * FROM saved_searches WHERE user_id = ? ORDER BY created_at DESC", uid(req)).map((s) => ({ ...s, query: parseJson(s.query, {}) })) }),
);
reader.post(
  "/saved-searches",
  asyncH((req, res) => {
    const b = parseBody(z.object({ name: z.string().min(1).max(80), query: z.record(z.string(), z.any()), alert: z.boolean().optional() }), req.body);
    const r = run("INSERT INTO saved_searches (user_id, name, query, alert, created_at) VALUES (?, ?, ?, ?, ?)", uid(req), b.name, json(b.query), b.alert ? 1 : 0, nowIso());
    res.json({ id: Number(r.lastInsertRowid) });
  }),
);
reader.patch(
  "/saved-searches/:id",
  asyncH((req, res) => {
    const b = parseBody(z.object({ alert: z.boolean() }), req.body);
    run("UPDATE saved_searches SET alert = ? WHERE id = ? AND user_id = ?", b.alert ? 1 : 0, intParam(req.params.id), uid(req));
    res.json({ ok: true });
  }),
);
reader.delete("/saved-searches/:id", (req, res) => {
  run("DELETE FROM saved_searches WHERE id = ? AND user_id = ?", intParam(req.params.id), uid(req));
  res.json({ ok: true });
});

// ---- Topics -------------------------------------------------------------------------

reader.get("/topics", (req, res) => {
  const userId = uid(req);
  const ctx = userContext(userId);
  const recent = storiesFor(ctx, { sinceHours: 72, limit: 600 });
  const rows = all<any>(
    `SELECT t.*, ut.state FROM topics t LEFT JOIN user_topics ut ON ut.topic_id = t.id AND ut.user_id = ?
     WHERE t.owner_id IS NULL OR t.owner_id = ? ORDER BY t.owner_id IS NULL, t.name`,
    userId, userId,
  );
  res.json({
    topics: rows.map((t) => ({
      id: t.id, slug: t.slug, name: t.name, description: t.description, keywords: parseJson(t.keywords, []), categories: parseJson(t.categories, []),
      matchMode: t.match_mode, custom: t.owner_id != null, state: t.state ?? null, recentStories: recent.filter((s) => s.topics.includes(t.id)).length,
    })),
  });
});

const TopicBody = z.object({
  name: z.string().min(2).max(60),
  description: z.string().max(300).optional().default(""),
  keywords: z.array(z.string().min(1).max(60)).max(30).default([]),
  categories: z.array(z.string()).max(10).default([]),
  matchMode: z.enum(["any", "all"]).default("any"),
});

reader.post(
  "/topics",
  asyncH((req, res) => {
    const b = parseBody(TopicBody, req.body);
    if (!b.keywords.length && !b.categories.length) throw new HttpError(400, "Add at least one keyword, entity or category.");
    const slug = b.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "topic";
    const r = run(
      "INSERT INTO topics (slug, name, description, keywords, categories, match_mode, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      `${slug}-${Date.now().toString(36)}`, b.name, b.description, json(b.keywords), json(b.categories.filter((c) => CATEGORIES.some((x) => x.key === c))), b.matchMode, uid(req), nowIso(),
    );
    const id = Number(r.lastInsertRowid);
    run("INSERT INTO user_topics (user_id, topic_id, state) VALUES (?, ?, 'follow')", uid(req), id);
    const matched = backfillTopic(id);
    res.json({ id, matchedArticles: matched });
  }),
);

reader.put(
  "/topics/:id",
  asyncH((req, res) => {
    const id = intParam(req.params.id);
    const t = get<any>("SELECT * FROM topics WHERE id = ? AND owner_id = ?", id, uid(req));
    if (!t) throw new HttpError(404, "Custom topic not found");
    const b = parseBody(TopicBody, req.body);
    run("UPDATE topics SET name = ?, description = ?, keywords = ?, categories = ?, match_mode = ? WHERE id = ?", b.name, b.description, json(b.keywords), json(b.categories), b.matchMode, id);
    res.json({ matchedArticles: backfillTopic(id) });
  }),
);

reader.delete(
  "/topics/:id",
  asyncH((req, res) => {
    const id = intParam(req.params.id);
    const r = run("DELETE FROM topics WHERE id = ? AND owner_id = ?", id, uid(req));
    if (!r.changes) throw new HttpError(404, "Custom topic not found");
    invalidateTopics();
    res.json({ ok: true });
  }),
);

reader.post(
  "/topics/:id/state",
  asyncH((req, res) => {
    const id = intParam(req.params.id);
    const b = parseBody(z.object({ state: z.enum(["follow", "mute", "none"]) }), req.body);
    if (!get("SELECT 1 FROM topics WHERE id = ? AND (owner_id IS NULL OR owner_id = ?)", id, uid(req))) throw new HttpError(404, "Topic not found");
    if (b.state === "none") run("DELETE FROM user_topics WHERE user_id = ? AND topic_id = ?", uid(req), id);
    else run("INSERT INTO user_topics (user_id, topic_id, state) VALUES (?, ?, ?) ON CONFLICT(user_id, topic_id) DO UPDATE SET state = excluded.state", uid(req), id, b.state);
    res.json({ ok: true });
  }),
);

reader.get(
  "/topics/:id",
  asyncH((req, res) => {
    const userId = uid(req);
    const id = intParam(req.params.id);
    const t = get<any>(
      "SELECT t.*, ut.state FROM topics t LEFT JOIN user_topics ut ON ut.topic_id = t.id AND ut.user_id = ? WHERE t.id = ? AND (t.owner_id IS NULL OR t.owner_id = ?)",
      userId, id, userId,
    );
    if (!t) throw new HttpError(404, "Topic not found");
    const ctx = userContext(userId);
    const stories = storiesFor(ctx, { sinceHours: 24 * 14, topicId: id, includeMuted: true, limit: 200 });
    const clusterIds = stories.map((s) => s.id);
    const timeline = clusterIds.length
      ? all<any>(
          `SELECT e.id, e.cluster_id, e.kind, e.text, e.at FROM cluster_events e WHERE e.significant = 1 AND e.cluster_id IN (${clusterIds.map(() => "?").join(",")})
           ORDER BY e.at DESC LIMIT 40`,
          ...clusterIds,
        )
      : [];
    const official = clusterIds.length
      ? all<any>(
          `SELECT a.id, a.headline, a.canonical_url, a.published_at, s.name AS source_name FROM articles a JOIN sources s ON s.id = a.source_id
           WHERE s.kind = 'official' AND a.cluster_id IN (${clusterIds.map(() => "?").join(",")}) ORDER BY a.published_at DESC LIMIT 10`,
          ...clusterIds,
        )
      : [];
    res.json({
      topic: { id: t.id, name: t.name, description: t.description, keywords: parseJson(t.keywords, []), categories: parseJson(t.categories, []), custom: t.owner_id != null, state: t.state ?? null, matchMode: t.match_mode },
      top: [...stories].sort((a, b) => b.importance - a.importance).slice(0, 8),
      recent: [...stories].sort((a, b) => b.lastUpdateAt.localeCompare(a.lastUpdateAt)).slice(0, 15),
      timeline,
      official,
      trends: topicTrends(userId, id, 30),
    });
  }),
);

// ---- Saved, reading lists, history, follows ----------------------------------------

const SaveBody = z.object({
  targetType: z.enum(["article", "story", "briefing"]),
  targetId: z.number().int().positive(),
  list: z.string().min(1).max(60).default("saved"),
  note: z.string().max(500).optional(),
});

reader.post(
  "/saved",
  asyncH((req, res) => {
    const b = parseBody(SaveBody, req.body);
    const table = b.targetType === "article" ? "articles" : b.targetType === "story" ? "clusters" : "briefings";
    if (!get(`SELECT 1 FROM ${table} WHERE id = ?`, b.targetId)) throw new HttpError(404, "Item not found");
    run(
      `INSERT INTO bookmarks (user_id, target_type, target_id, list, note, saved_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, target_type, target_id, list) DO UPDATE SET note = COALESCE(excluded.note, bookmarks.note)`,
      uid(req), b.targetType, b.targetId, b.list, b.note ?? null, nowIso(),
    );
    res.json({ ok: true });
  }),
);

reader.delete(
  "/saved",
  asyncH((req, res) => {
    const b = parseBody(SaveBody.omit({ note: true }), req.body);
    run("DELETE FROM bookmarks WHERE user_id = ? AND target_type = ? AND target_id = ? AND list = ?", uid(req), b.targetType, b.targetId, b.list);
    res.json({ ok: true });
  }),
);

reader.patch(
  "/saved/read",
  asyncH((req, res) => {
    const b = parseBody(SaveBody.omit({ note: true }).extend({ read: z.boolean() }), req.body);
    run(
      "UPDATE bookmarks SET read_at = ? WHERE user_id = ? AND target_type = ? AND target_id = ? AND list = ?",
      b.read ? nowIso() : null, uid(req), b.targetType, b.targetId, b.list,
    );
    res.json({ ok: true });
  }),
);

reader.get(
  "/saved",
  asyncH((req, res) => {
    const userId = uid(req);
    const rows = all<any>("SELECT * FROM bookmarks WHERE user_id = ? ORDER BY saved_at DESC", userId);
    const artIds = rows.filter((r) => r.target_type === "article").map((r) => r.target_id);
    const arts = artIds.length
      ? all<any>(
          `SELECT a.id, a.headline, a.description, a.canonical_url, a.published_at, a.link_status, a.cluster_id, s.name AS source_name
           FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id IN (${artIds.map(() => "?").join(",")})`,
          ...artIds,
        )
      : [];
    const storyIds = rows.filter((r) => r.target_type === "story").map((r) => r.target_id);
    const stories = storyIds.length
      ? all<any>(`SELECT id, headline, category, last_update_at, status, article_count, source_count FROM clusters WHERE id IN (${storyIds.map(() => "?").join(",")})`, ...storyIds)
      : [];
    const briefIds = rows.filter((r) => r.target_type === "briefing").map((r) => r.target_id);
    const briefs = briefIds.length
      ? all<any>(`SELECT id, edition_date, edition, generated_at, revision FROM briefings WHERE id IN (${briefIds.map(() => "?").join(",")})`, ...briefIds)
      : [];
    const items = rows
      .map((r) => {
        const target =
          r.target_type === "article" ? arts.find((a) => a.id === r.target_id) : r.target_type === "story" ? stories.find((s) => s.id === r.target_id) : briefs.find((b) => b.id === r.target_id);
        return target ? { list: r.list, targetType: r.target_type, targetId: r.target_id, savedAt: r.saved_at, readAt: r.read_at, note: r.note, target } : null;
      })
      .filter(Boolean);
    const lists = [...new Set(rows.map((r) => r.list))];
    res.json({ items, lists });
  }),
);

reader.get(
  "/history",
  asyncH((req, res) => {
    const rows = all<any>(
      `SELECT h.target_type, h.target_id, MAX(h.at) AS at,
        CASE h.target_type WHEN 'article' THEN (SELECT headline FROM articles WHERE id = h.target_id) ELSE (SELECT headline FROM clusters WHERE id = h.target_id) END AS headline
       FROM reading_history h WHERE h.user_id = ? GROUP BY h.target_type, h.target_id ORDER BY at DESC LIMIT 100`,
      uid(req),
    );
    res.json({ items: rows.filter((r) => r.headline) });
  }),
);

reader.delete("/history", (req, res) => {
  run("DELETE FROM reading_history WHERE user_id = ?", uid(req));
  res.json({ ok: true });
});

// ---- Notifications --------------------------------------------------------------------

reader.get("/notifications", (req, res) => {
  const userId = uid(req);
  const items = all<any>("SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100", userId);
  const deliveries = items.length
    ? all<any>(`SELECT * FROM notification_deliveries WHERE notification_id IN (${items.map(() => "?").join(",")})`, ...items.map((i) => i.id))
    : [];
  res.json({
    unread: items.filter((i) => !i.read_at).length,
    items: items.map((i) => ({ ...i, deliveries: deliveries.filter((d) => d.notification_id === i.id) })),
    channels: channelStatus(),
  });
});
reader.post("/notifications/read-all", (req, res) => {
  run("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL", nowIso(), uid(req));
  res.json({ ok: true });
});
reader.post("/notifications/:id/read", (req, res) => {
  run("UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?", nowIso(), intParam(req.params.id), uid(req));
  res.json({ ok: true });
});
reader.post(
  "/notifications/test",
  asyncH(async (req, res) => {
    const id = await sendTestNotification(uid(req));
    const deliveries = id ? all<any>("SELECT channel, status, error FROM notification_deliveries WHERE notification_id = ?", id) : [];
    res.json({ id, deliveries });
  }),
);
reader.post(
  "/push/subscribe",
  asyncH((req, res) => {
    const b = parseBody(z.object({ endpoint: z.string().url(), keys: z.object({ p256dh: z.string(), auth: z.string() }) }), req.body);
    run(
      "INSERT INTO push_subscriptions (user_id, endpoint, keys, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys = excluded.keys",
      uid(req), b.endpoint, json(b.keys), nowIso(),
    );
    res.json({ ok: true });
  }),
);
reader.delete("/push/subscribe", (req, res) => {
  run("DELETE FROM push_subscriptions WHERE user_id = ?", uid(req));
  res.json({ ok: true });
});

// ---- Upcoming events ------------------------------------------------------------------

reader.get("/upcoming", (req, res) => {
  const userId = uid(req);
  res.json({
    upcoming: all<any>("SELECT * FROM upcoming_events WHERE (created_by IS NULL OR created_by = ?) AND (starts_at IS NULL OR starts_at >= ?) ORDER BY starts_at IS NULL, starts_at LIMIT 50", userId, nowIso()),
    past: all<any>("SELECT * FROM upcoming_events WHERE (created_by IS NULL OR created_by = ?) AND starts_at < ? ORDER BY starts_at DESC LIMIT 50", userId, nowIso()),
  });
});
reader.post(
  "/upcoming",
  asyncH((req, res) => {
    const b = parseBody(
      z.object({
        title: z.string().min(3).max(200),
        startsAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "invalid date"),
        certainty: z.enum(["confirmed", "scheduled", "estimated"]),
        why: z.string().max(400).optional(),
        sourceUrl: z.string().url().optional(),
        sourceName: z.string().max(100).optional(),
      }),
      req.body,
    );
    const r = run(
      "INSERT INTO upcoming_events (title, starts_at, certainty, why, source_url, source_name, origin, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 'user', ?, ?)",
      b.title, new Date(b.startsAt).toISOString(), b.certainty, b.why ?? null, b.sourceUrl ?? null, b.sourceName ?? null, uid(req), nowIso(),
    );
    res.json({ id: Number(r.lastInsertRowid) });
  }),
);
reader.delete("/upcoming/:id", (req, res) => {
  run("DELETE FROM upcoming_events WHERE id = ? AND created_by = ?", intParam(req.params.id), uid(req));
  res.json({ ok: true });
});

// ---- Advanced: ask, weekly ---------------------------------------------------------

reader.post(
  "/ask",
  asyncH(async (req, res) => {
    const b = parseBody(z.object({ question: z.string().min(3).max(600), clusterId: z.number().int().positive().optional() }), req.body);
    try {
      res.json(await askQuestion(uid(req), b.question, b.clusterId));
    } catch (e: any) {
      res.status(502).json({ status: "error", error: e.message });
    }
  }),
);

reader.get(
  "/weekly",
  asyncH(async (req, res) => {
    res.json(await weeklyRecap(uid(req), { refresh: req.query.refresh === "1" }));
  }),
);

reader.get("/categories", (_req, res) => res.json({ categories: CATEGORIES }));

export { aiStatus };
