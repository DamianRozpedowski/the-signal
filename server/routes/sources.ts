import { Router } from "express";
import { z } from "zod";
import { rateLimit, requireUser } from "../auth.ts";
import { all, get, nowIso, run, tx } from "../db.ts";
import { activeSourceIds } from "../edition.ts";
import { ingestSource, validateFeedUrl } from "../ingest/pipeline.ts";
import { enqueue } from "../ingest/scheduler.ts";
import { canonicalizeUrl } from "../process/text.ts";
import { CATEGORIES } from "../process/taxonomy.ts";
import { PRESETS } from "../sources/catalog.ts";
import { HttpError, asyncH, intParam, parseBody } from "./util.ts";

export const sources = Router();
sources.use(requireUser);
const uid = (req: any) => req.user.id as number;

function sourceList(userId: number) {
  const rows = all<any>(
    `SELECT s.*, us.enabled AS user_enabled, us.priority AS user_priority,
       (SELECT COUNT(*) FROM articles a WHERE a.source_id = s.id AND a.retrieved_at >= ?) AS articles_24h
     FROM sources s LEFT JOIN user_sources us ON us.source_id = s.id AND us.user_id = ?
     WHERE s.is_custom = 0 OR s.created_by = ? OR EXISTS (SELECT 1 FROM users u WHERE u.id = ? AND u.is_admin = 1)
     ORDER BY s.name`,
    new Date(Date.now() - 86_400_000).toISOString(), userId, userId, userId,
  );
  return rows.map((s) => ({
    id: s.id,
    slug: s.slug,
    name: s.name,
    description: s.description,
    siteUrl: s.site_url,
    feedUrl: s.feed_url,
    favicon: s.site_url ? `${new URL(s.site_url).origin}/favicon.ico` : null,
    integration: s.integration,
    category: s.category,
    kind: s.kind,
    region: s.region,
    custom: Boolean(s.is_custom),
    defaultEnabled: Boolean(s.default_enabled),
    enabled: s.admin_disabled ? false : s.user_enabled != null ? Boolean(s.user_enabled) : Boolean(s.default_enabled),
    adminDisabled: Boolean(s.admin_disabled),
    priority: s.user_priority ?? 0,
    status: s.admin_disabled ? "disabled" : s.status,
    lastSuccessAt: s.last_success_at,
    lastAttemptAt: s.last_attempt_at,
    lastNewItemAt: s.last_new_item_at,
    lastError: s.last_error,
    nextFetchAt: s.next_fetch_at,
    intervalMinutes: s.interval_minutes,
    observedItemsPerDay: s.observed_items_per_day,
    articleCount: s.article_count,
    articles24h: s.articles_24h,
  }));
}

sources.get("/", (req, res) => {
  res.json({ sources: sourceList(uid(req)), presets: PRESETS, categories: CATEGORIES });
});

sources.get(
  "/:id/detail",
  asyncH((req, res) => {
    const id = intParam(req.params.id);
    const s = sourceList(uid(req)).find((x) => x.id === id);
    if (!s) throw new HttpError(404, "Source not found");
    res.json({
      source: s,
      jobs: all<any>("SELECT * FROM ingest_jobs WHERE source_id = ? ORDER BY started_at DESC LIMIT 20", id),
      recent: all<any>("SELECT id, headline, canonical_url, published_at, retrieved_at, cluster_id, category FROM articles WHERE source_id = ? ORDER BY published_at DESC LIMIT 15", id),
    });
  }),
);

/** Save a batch of checklist changes in one go. */
sources.put(
  "/selection",
  asyncH((req, res) => {
    const b = parseBody(z.object({ changes: z.array(z.object({ id: z.number().int(), enabled: z.boolean(), priority: z.number().int().min(-2).max(2).optional() })).max(1000) }), req.body);
    const userId = uid(req);
    const before = new Set(activeSourceIds(userId));
    tx(() => {
      for (const c of b.changes) {
        run(
          `INSERT INTO user_sources (user_id, source_id, enabled, priority) VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id, source_id) DO UPDATE SET enabled = excluded.enabled, priority = COALESCE(?, user_sources.priority)`,
          userId, c.id, c.enabled ? 1 : 0, c.priority ?? 0, c.priority ?? null,
        );
      }
    });
    const after = activeSourceIds(userId);
    // Newly enabled sources that have never been fetched are queued right away.
    const newlyEnabled = after.filter((id) => !before.has(id));
    for (const id of newlyEnabled) {
      const s = get<{ last_success_at: string | null }>("SELECT last_success_at FROM sources WHERE id = ?", id);
      if (!s?.last_success_at) enqueue(id, "manual");
    }
    res.json({ ok: true, active: after.length, queued: newlyEnabled.length });
  }),
);

sources.post(
  "/restore-defaults",
  asyncH((req, res) => {
    run("DELETE FROM user_sources WHERE user_id = ?", uid(req));
    res.json({ ok: true, active: activeSourceIds(uid(req)).length });
  }),
);

sources.post(
  "/preset/:key",
  asyncH((req, res) => {
    const preset = PRESETS.find((p) => p.key === req.params.key);
    if (!preset) throw new HttpError(404, "Unknown preset");
    const userId = uid(req);
    const all_ = all<any>("SELECT id, category, default_enabled, is_custom, created_by FROM sources WHERE admin_disabled = 0");
    tx(() => {
      for (const s of all_) {
        if (s.is_custom && s.created_by !== userId) continue;
        const inCategory = !preset.categories.length || preset.categories.includes(s.category);
        const enabled = inCategory && (preset.includeDisabledByDefault || s.default_enabled || s.is_custom);
        run(
          `INSERT INTO user_sources (user_id, source_id, enabled) VALUES (?, ?, ?) ON CONFLICT(user_id, source_id) DO UPDATE SET enabled = excluded.enabled`,
          userId, s.id, enabled ? 1 : 0,
        );
      }
    });
    const active = activeSourceIds(userId);
    for (const id of active) {
      const s = get<{ last_success_at: string | null }>("SELECT last_success_at FROM sources WHERE id = ?", id);
      if (!s?.last_success_at) enqueue(id, "manual");
    }
    res.json({ ok: true, active: active.length });
  }),
);

sources.post(
  "/validate",
  rateLimit(20, 60_000),
  asyncH(async (req, res) => {
    const b = parseBody(z.object({ url: z.string().min(4).max(2000) }), req.body);
    res.json(await validateFeedUrl(b.url));
  }),
);

sources.post(
  "/",
  rateLimit(10, 60_000),
  asyncH(async (req, res) => {
    const b = parseBody(
      z.object({
        url: z.string().min(4).max(2000),
        name: z.string().min(2).max(120).optional(),
        description: z.string().max(400).optional(),
        category: z.string().refine((c) => CATEGORIES.some((x) => x.key === c), "unknown category"),
        kind: z.enum(["publisher", "public_broadcaster", "wire", "official", "analysis", "aggregator"]).default("publisher"),
        region: z.string().max(10).optional(),
        intervalMinutes: z.number().int().min(10).max(1440).default(30),
      }),
      req.body,
    );
    // Validation is repeated server-side; the source is only created if it passes.
    const report = await validateFeedUrl(b.url);
    if (!report.ok || !report.feed) return res.status(422).json({ error: "This source could not be validated.", report });
    const feedUrl = report.discoveredFeedUrl ?? (/^https?:\/\//i.test(b.url) ? b.url.trim() : `https://${b.url.trim()}`);
    if (get("SELECT 1 FROM sources WHERE feed_url = ?", feedUrl)) throw new HttpError(409, "This feed is already registered.");
    const name = b.name?.trim() || report.feed.title || new URL(feedUrl).hostname;
    const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}-${Date.now().toString(36)}`;
    const r = run(
      `INSERT INTO sources (slug, name, description, site_url, feed_url, integration, category, kind, region, default_enabled, is_custom, created_by,
         interval_minutes, status, validation, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, 'pending', ?, ?)`,
      slug, name, b.description ?? report.feed.description ?? "", report.feed.siteUrl ? canonicalizeUrl(report.feed.siteUrl) : "", feedUrl,
      report.feed.format, b.category, b.kind, b.region ?? null, uid(req), b.intervalMinutes, JSON.stringify(report), nowIso(),
    );
    const id = Number(r.lastInsertRowid);
    run("INSERT INTO user_sources (user_id, source_id, enabled) VALUES (?, ?, 1)", uid(req), id);
    // First ingestion runs immediately so the reader sees results (or a clear error) right away.
    const outcome = await ingestSource(id, "validation");
    res.json({ id, outcome, report });
  }),
);

sources.delete(
  "/:id",
  asyncH((req, res) => {
    const id = intParam(req.params.id);
    const s = get<any>("SELECT * FROM sources WHERE id = ?", id);
    if (!s) throw new HttpError(404, "Source not found");
    if (!s.is_custom || (s.created_by !== uid(req) && !(req as any).user.is_admin)) throw new HttpError(403, "Only custom sources you added can be removed. Built-in sources can be disabled instead.");
    run("DELETE FROM sources WHERE id = ?", id);
    res.json({ ok: true });
  }),
);

sources.post(
  "/:id/refresh",
  rateLimit(30, 60_000),
  asyncH((req, res) => {
    const id = intParam(req.params.id);
    if (!get("SELECT 1 FROM sources WHERE id = ? AND admin_disabled = 0", id)) throw new HttpError(404, "Source not found or disabled by an administrator");
    res.json({ queued: enqueue(id, "manual", true) });
  }),
);

/** Coverage diversity of the reader's active sources (transparent attributes, no truth scores). */
sources.get("/diversity", (req, res) => {
  const ids = activeSourceIds(uid(req));
  if (!ids.length) return res.json({ total: 0, byKind: [], byCategory: [], byRegion: [], articleTypes: [], corroboration: null });
  const inIds = `(${ids.map(() => "?").join(",")})`;
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const byKind = all<any>(`SELECT kind, COUNT(*) AS n FROM sources WHERE id IN ${inIds} GROUP BY kind`, ...ids);
  const byCategory = all<any>(`SELECT category, COUNT(*) AS n FROM sources WHERE id IN ${inIds} GROUP BY category`, ...ids);
  const byRegion = all<any>(`SELECT COALESCE(region, 'unspecified') AS region, COUNT(*) AS n FROM sources WHERE id IN ${inIds} GROUP BY region`, ...ids);
  const articleTypes = all<any>(`SELECT article_type, COUNT(*) AS n FROM articles WHERE source_id IN ${inIds} AND published_at >= ? GROUP BY article_type`, ...ids, since);
  const corroboration = get<any>(
    `SELECT SUM(CASE WHEN source_count >= 2 THEN 1 ELSE 0 END) AS multi, SUM(CASE WHEN source_count = 1 THEN 1 ELSE 0 END) AS single,
       SUM(has_official) AS official FROM clusters WHERE last_article_at >= ?`,
    since,
  );
  const corrections = all<any>(
    `SELECT s.name, COUNT(*) AS n FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.source_id IN ${inIds} AND a.correction_status IN ('corrected','retracted')
     GROUP BY s.name ORDER BY n DESC LIMIT 10`,
    ...ids,
  );
  res.json({ total: ids.length, byKind, byCategory, byRegion, articleTypes, corroboration, corrections });
});
