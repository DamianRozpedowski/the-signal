import { Router } from "express";
import { z } from "zod";
import { requireAdmin } from "../auth.ts";
import { aiStatusDetail } from "../ai/provider.ts";
import { summarizeArticle, summarizeCluster } from "../ai/tasks.ts";
import { regenerateEdition } from "../briefing/generate.ts";
import { all, get, json, nowIso, parseJson, run } from "../db.ts";
import { activeSourceIds, storiesFor, userContext } from "../edition.ts";
import { enqueue, queueStatus } from "../ingest/scheduler.ts";
import { classify } from "../process/classify.ts";
import { articleTerms, assignCluster, indexStats, recalculateCluster, refreshClusterAggregates, removeDoc } from "../process/cluster.ts";
import { getWeights, rerank, setWeights, DEFAULT_WEIGHTS } from "../process/rank.ts";
import { CATEGORIES } from "../process/taxonomy.ts";
import { canonicalizeUrl, urlKey } from "../process/text.ts";
import { matchTopics } from "../process/topics.ts";
import { buildFtsQuery } from "../search.ts";
import { HttpError, asyncH, intParam, parseBody, qstr } from "./util.ts";

export const admin = Router();
admin.use(requireAdmin);

admin.get("/overview", (_req, res) => {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  res.json({
    counts: {
      sources: get<any>("SELECT COUNT(*) AS n, SUM(admin_disabled) AS disabled, SUM(CASE WHEN status IN ('error','degraded') THEN 1 ELSE 0 END) AS failing FROM sources"),
      articles: get<any>("SELECT COUNT(*) AS n, SUM(CASE WHEN retrieved_at >= ? THEN 1 ELSE 0 END) AS last24h FROM articles", since),
      clusters: get<any>("SELECT COUNT(*) AS n, SUM(CASE WHEN last_article_at >= ? THEN 1 ELSE 0 END) AS active24h, SUM(is_breaking) AS breaking, SUM(needs_resummary) AS awaitingSummary FROM clusters", since),
      duplicates24h: get<any>("SELECT COUNT(*) AS n FROM duplicate_log WHERE at >= ?", since)?.n ?? 0,
      users: get<any>("SELECT COUNT(*) AS n FROM users")?.n ?? 0,
    },
    jobs24h: all<any>("SELECT status, COUNT(*) AS n FROM ingest_jobs WHERE started_at >= ? GROUP BY status", since),
    ai: {
      ...aiStatusDetail(),
      usage24h: all<any>(
        "SELECT kind, status, COUNT(*) AS n, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens FROM ai_jobs WHERE started_at >= ? GROUP BY kind, status",
        since,
      ),
    },
    queue: queueStatus(),
    index: indexStats(),
    notificationFailures24h: get<any>("SELECT COUNT(*) AS n FROM notification_deliveries WHERE status IN ('failed','not_configured') AND at >= ?", since)?.n ?? 0,
    processingFailures: get<any>("SELECT COUNT(*) AS n FROM articles WHERE processing_error IS NOT NULL")?.n ?? 0,
    lastBriefing: get<any>("SELECT id, user_id, edition_date, edition, generated_at, ai_status FROM briefings ORDER BY generated_at DESC LIMIT 1") ?? null,
  });
});

admin.get("/sources", (_req, res) => {
  res.json({
    sources: all<any>(
      `SELECT s.*, (SELECT COUNT(*) FROM user_sources us WHERE us.source_id = s.id AND us.enabled = 1) AS readers_enabled
       FROM sources s ORDER BY CASE s.status WHEN 'error' THEN 0 WHEN 'degraded' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END, s.name`,
    ),
  });
});

admin.patch(
  "/sources/:id",
  asyncH((req, res) => {
    const id = intParam(req.params.id);
    const b = parseBody(
      z.object({
        name: z.string().min(2).max(120).optional(),
        feedUrl: z.string().url().optional(),
        category: z.string().refine((c) => CATEGORIES.some((x) => x.key === c)).optional(),
        kind: z.enum(["publisher", "public_broadcaster", "wire", "official", "analysis", "aggregator"]).optional(),
        region: z.string().max(10).nullable().optional(),
        intervalMinutes: z.number().int().min(5).max(1440).optional(),
        priority: z.number().int().min(-5).max(5).optional(),
        adminDisabled: z.boolean().optional(),
        defaultEnabled: z.boolean().optional(),
      }),
      req.body,
    );
    const s = get<any>("SELECT * FROM sources WHERE id = ?", id);
    if (!s) throw new HttpError(404, "Source not found");
    run(
      `UPDATE sources SET name = ?, feed_url = ?, category = ?, kind = ?, region = ?, interval_minutes = ?, priority = ?, admin_disabled = ?, default_enabled = ?,
         etag = CASE WHEN ? != feed_url THEN NULL ELSE etag END, last_modified = CASE WHEN ? != feed_url THEN NULL ELSE last_modified END,
         status = CASE WHEN ? = 1 THEN 'disabled' WHEN status = 'disabled' THEN 'pending' ELSE status END,
         next_fetch_at = CASE WHEN ? != feed_url THEN NULL ELSE next_fetch_at END
       WHERE id = ?`,
      b.name ?? s.name, b.feedUrl ?? s.feed_url, b.category ?? s.category, b.kind ?? s.kind, b.region === undefined ? s.region : b.region,
      b.intervalMinutes ?? s.interval_minutes, b.priority ?? s.priority, b.adminDisabled === undefined ? s.admin_disabled : b.adminDisabled ? 1 : 0,
      b.defaultEnabled === undefined ? s.default_enabled : b.defaultEnabled ? 1 : 0,
      b.feedUrl ?? s.feed_url, b.feedUrl ?? s.feed_url, b.adminDisabled ? 1 : 0, b.feedUrl ?? s.feed_url, id,
    );
    run("INSERT INTO app_log (at, level, area, message, data) VALUES (?, 'info', 'admin', ?, ?)", nowIso(), `Source ${s.name} configuration changed`, json({ by: (req as any).user.id, changes: b }));
    res.json({ ok: true });
  }),
);

admin.post("/sources/:id/retry", (req, res) => {
  const id = intParam(req.params.id);
  run("UPDATE sources SET next_fetch_at = NULL WHERE id = ?", id);
  res.json({ queued: enqueue(id, "retry", true) });
});

admin.post("/ingest-all", (_req, res) => {
  const ids = all<{ id: number }>("SELECT id FROM sources WHERE admin_disabled = 0").map((r) => r.id);
  let n = 0;
  for (const id of ids) if (enqueue(id, "manual")) n++;
  res.json({ queued: n });
});

admin.get("/jobs", (req, res) => {
  const status = qstr(req.query.status);
  res.json({
    jobs: all<any>(
      `SELECT j.*, s.name AS source_name FROM ingest_jobs j JOIN sources s ON s.id = j.source_id ${status ? "WHERE j.status = ?" : ""} ORDER BY j.started_at DESC LIMIT 200`,
      ...(status ? [status] : []),
    ),
    queue: queueStatus(),
  });
});

admin.get("/duplicates", (_req, res) => {
  res.json({
    items: all<any>(
      `SELECT d.*, s.name AS source_name, a.headline AS matched_headline FROM duplicate_log d LEFT JOIN sources s ON s.id = d.source_id
       LEFT JOIN articles a ON a.id = d.matched_article_id ORDER BY d.at DESC LIMIT 200`,
    ),
    byMethod: all<any>("SELECT method, COUNT(*) AS n FROM duplicate_log GROUP BY method"),
  });
});

admin.get("/clusters", (req, res) => {
  const q = qstr(req.query.q);
  res.json({
    clusters: all<any>(
      `SELECT id, headline, category, status, importance, importance_reasons, article_count, source_count, is_breaking, first_seen_at, last_update_at,
         summary IS NOT NULL AS has_summary, needs_resummary, summary_error
       FROM clusters ${q ? "WHERE headline LIKE ?" : ""} ORDER BY last_article_at DESC LIMIT 200`,
      ...(q ? [`%${q}%`] : []),
    ).map((c) => ({ ...c, importance_reasons: parseJson(c.importance_reasons, []) })),
  });
});

admin.get("/clusters/:id", (req, res) => {
  const id = intParam(req.params.id);
  const c = get<any>("SELECT * FROM clusters WHERE id = ?", id);
  if (!c) throw new HttpError(404, "Cluster not found");
  res.json({
    cluster: c,
    articles: all<any>(
      "SELECT a.id, a.headline, a.published_at, a.simhash, a.category, a.article_type, s.name AS source_name FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.cluster_id = ? ORDER BY a.published_at",
      id,
    ),
    events: all<any>("SELECT * FROM cluster_events WHERE cluster_id = ? ORDER BY at", id),
    aiJobs: all<any>("SELECT * FROM ai_jobs WHERE kind = 'cluster_summary' AND target_id = ? ORDER BY id DESC LIMIT 10", id),
  });
});

admin.post("/clusters/:id/recalculate", (req, res) => {
  const touched = recalculateCluster(intParam(req.params.id));
  rerank(touched);
  res.json({ clusters: touched });
});

admin.post(
  "/clusters/:id/resummarize",
  asyncH(async (req, res) => {
    res.json(await summarizeCluster(intParam(req.params.id), { force: true }));
  }),
);

admin.post(
  "/articles/:id/reprocess",
  asyncH(async (req, res) => {
    const id = intParam(req.params.id);
    const a = get<any>("SELECT a.*, s.category AS source_category, s.kind AS source_kind, s.region AS source_region FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ?", id);
    if (!a) throw new HttpError(404, "Article not found");
    const cls = classify({ title: a.headline, description: a.description ?? "", url: a.canonical_url, sourceCategory: a.source_category, sourceKind: a.source_kind, sourceRegion: a.source_region });
    const termList = articleTerms(a.headline, a.description ?? "");
    const topics = matchTopics(`${a.headline}. ${a.description ?? ""}`, cls.category);
    run(
      "UPDATE articles SET category = ?, geo = ?, article_type = ?, terms = ?, topics = ?, processing_error = NULL, cluster_id = NULL WHERE id = ?",
      cls.category, json(cls.geo), cls.articleType, json(termList), json(topics), id,
    );
    removeDoc(id);
    if (a.cluster_id) refreshClusterAggregates(a.cluster_id);
    const assignment = assignCluster({
      id, sourceId: a.source_id, sourceKind: a.source_kind, title: a.headline, description: a.description ?? "", termList,
      entities: parseJson(a.entities, []), simhash: a.simhash, publishedAt: a.published_at, category: cls.category, articleType: cls.articleType,
    });
    rerank([assignment.clusterId, ...(a.cluster_id ? [a.cluster_id] : [])]);
    const summary = await summarizeArticle(id, { force: true });
    res.json({ classification: cls, assignment, summary });
  }),
);

admin.get("/articles/:id/provenance", (req, res) => {
  const id = intParam(req.params.id);
  const a = get<any>("SELECT a.*, s.name AS source_name, s.feed_url FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ?", id);
  if (!a) throw new HttpError(404, "Article not found");
  res.json({
    article: { ...a, terms: parseJson(a.terms, []), entities: parseJson(a.entities, []), topics: parseJson(a.topics, []), geo: parseJson(a.geo, []) },
    firstJob: get<any>("SELECT * FROM ingest_jobs WHERE source_id = ? AND started_at <= ? ORDER BY started_at DESC LIMIT 1", a.source_id, a.retrieved_at),
    revisions: all<any>("SELECT * FROM article_revisions WHERE article_id = ? ORDER BY at", id),
    duplicatesPointingHere: all<any>("SELECT * FROM duplicate_log WHERE matched_article_id = ? ORDER BY at DESC LIMIT 50", id),
    clusterEvents: all<any>("SELECT * FROM cluster_events WHERE article_id = ?", id),
    aiJobs: all<any>("SELECT * FROM ai_jobs WHERE kind = 'article_summary' AND target_id = ? ORDER BY id DESC", id),
  });
});

admin.get("/briefings", (_req, res) => {
  res.json({
    briefings: all<any>(
      `SELECT b.id, b.user_id, u.email, b.edition_date, b.edition, b.generated_at, b.status, b.revision, b.revision_reason, b.ai_status, b.ai_model,
         json_array_length(b.story_ids) AS stories FROM briefings b JOIN users u ON u.id = b.user_id ORDER BY b.generated_at DESC LIMIT 100`,
    ),
    aiJobs: all<any>("SELECT * FROM ai_jobs WHERE kind = 'briefing' ORDER BY id DESC LIMIT 20"),
  });
});

admin.post(
  "/briefings/:id/regenerate",
  asyncH(async (req, res) => {
    res.json(await regenerateEdition(intParam(req.params.id)));
  }),
);

admin.get("/notifications", (_req, res) => {
  res.json({
    failures: all<any>(
      `SELECT d.*, n.title, n.user_id, n.kind FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id
       WHERE d.status IN ('failed','not_configured') ORDER BY d.at DESC LIMIT 200`,
    ),
    summary: all<any>("SELECT channel, status, COUNT(*) AS n FROM notification_deliveries GROUP BY channel, status"),
  });
});

admin.get("/ai-jobs", (_req, res) => {
  res.json({ jobs: all<any>("SELECT * FROM ai_jobs ORDER BY id DESC LIMIT 200"), failedArticles: all<any>("SELECT id, headline, processing_error FROM articles WHERE processing_error IS NOT NULL ORDER BY id DESC LIMIT 100") });
});

admin.get("/logs", (req, res) => {
  const level = qstr(req.query.level);
  res.json({
    logs: all<any>(`SELECT * FROM app_log ${level ? "WHERE level = ?" : ""} ORDER BY id DESC LIMIT 300`, ...(level ? [level] : [])).map((l) => ({ ...l, data: parseJson(l.data, null) })),
  });
});

admin.get("/ranking-weights", (_req, res) => res.json({ weights: getWeights(), defaults: DEFAULT_WEIGHTS }));
admin.put(
  "/ranking-weights",
  asyncH((req, res) => {
    const schema = z.object(Object.fromEntries(Object.keys(DEFAULT_WEIGHTS).map((k) => [k, z.number().min(-50).max(60).optional()])));
    setWeights(parseBody(schema, req.body) as any);
    const ids = all<{ id: number }>("SELECT id FROM clusters WHERE last_article_at >= ?", new Date(Date.now() - 4 * 86_400_000).toISOString()).map((r) => r.id);
    rerank(ids);
    res.json({ weights: getWeights(), reranked: ids.length });
  }),
);

/**
 * Diagnose why a story or article is (not) appearing for a given reader:
 * walks the pipeline from source to edition and reports each stage.
 */
admin.get(
  "/diagnose",
  asyncH((req, res) => {
    const q = qstr(req.query.q);
    const userId = Number(req.query.userId) || (req as any).user.id;
    if (!q) throw new HttpError(400, "Provide a URL or headline text");
    const steps: { stage: string; ok: boolean; detail: string }[] = [];
    let article: any;
    if (/^https?:\/\//.test(q)) {
      article = get<any>("SELECT * FROM articles WHERE url_key = ?", urlKey(q));
      const dup = get<any>("SELECT * FROM duplicate_log WHERE candidate_url = ? ORDER BY at DESC LIMIT 1", canonicalizeUrl(q));
      if (!article && dup) {
        steps.push({ stage: "Deduplication", ok: true, detail: `Skipped as a duplicate (${dup.method}) of article #${dup.matched_article_id}.` });
        article = get<any>("SELECT * FROM articles WHERE id = ?", dup.matched_article_id);
      }
    } else {
      const { query } = buildFtsQuery(q, false);
      article = query ? get<any>("SELECT a.* FROM articles_fts JOIN articles a ON a.id = articles_fts.rowid WHERE articles_fts MATCH ? ORDER BY bm25(articles_fts) LIMIT 1", query) : undefined;
    }
    if (!article) {
      steps.push({ stage: "Ingestion", ok: false, detail: "No article matching this URL or text has been collected. Check that a source carrying it is registered, enabled and healthy." });
      return res.json({ steps });
    }
    const source = get<any>("SELECT * FROM sources WHERE id = ?", article.source_id);
    steps.push({ stage: "Ingestion", ok: true, detail: `Collected from ${source.name} at ${article.retrieved_at} (published ${article.published_at}${article.published_at_estimated ? ", estimated" : ""}).` });
    steps.push({ stage: "Source status", ok: !source.admin_disabled && source.status !== "error", detail: source.admin_disabled ? "Disabled by an administrator." : `Status ${source.status}${source.last_error ? `: ${source.last_error}` : ""}.` });
    const active = activeSourceIds(userId).includes(source.id);
    steps.push({ stage: "Reader's sources", ok: active, detail: active ? "The reader has this source enabled." : "The reader has this source disabled, so its articles are excluded from their edition." });
    steps.push({ stage: "Classification", ok: true, detail: `Category ${article.category}; type ${article.article_type}; topics ${article.topics}.` });
    if (!article.cluster_id) {
      steps.push({ stage: "Clustering", ok: false, detail: "Not assigned to a story. Use Reprocess to retry." });
      return res.json({ steps, articleId: article.id });
    }
    const c = get<any>("SELECT * FROM clusters WHERE id = ?", article.cluster_id);
    steps.push({ stage: "Clustering", ok: true, detail: `Story #${c.id} “${c.headline}” with ${c.article_count} articles from ${c.source_count} sources.` });
    steps.push({ stage: "Ranking", ok: true, detail: `Importance ${c.importance}: ${parseJson<any[]>(c.importance_reasons, []).map((r) => `${r.label} (${r.points})`).join("; ") || "no notable signals"}.` });
    const ctx = userContext(userId);
    const ranked = storiesFor(ctx, { sinceHours: 72 });
    const pos = ranked.findIndex((s) => s.id === c.id);
    const muted = !storiesFor(ctx, { clusterIds: [c.id] }).length && storiesFor(ctx, { clusterIds: [c.id], includeMuted: true }).length;
    steps.push({
      stage: "Reader's edition",
      ok: pos >= 0,
      detail:
        pos >= 0
          ? `Ranked #${pos + 1} of ${ranked.length} stories in the reader's edition (last 72h).`
          : muted
            ? "Hidden because it matches a topic the reader muted."
            : "Not in the reader's current edition (older than 72 hours or no enabled sources).",
    });
    res.json({ steps, articleId: article.id, clusterId: c.id });
  }),
);

admin.get("/users", (_req, res) => {
  res.json({ users: all<any>("SELECT id, email, display_name, is_admin, timezone, created_at FROM users ORDER BY id") });
});
admin.patch(
  "/users/:id",
  asyncH((req, res) => {
    const b = parseBody(z.object({ isAdmin: z.boolean() }), req.body);
    const id = intParam(req.params.id);
    if (id === (req as any).user.id && !b.isAdmin) throw new HttpError(400, "You cannot remove your own administrator access.");
    run("UPDATE users SET is_admin = ? WHERE id = ?", b.isAdmin ? 1 : 0, id);
    res.json({ ok: true });
  }),
);
