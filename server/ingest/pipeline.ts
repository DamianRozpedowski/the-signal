import { config } from "../config.ts";
import { all, get, json, nowIso, parseJson, run, tx } from "../db.ts";
import { emit } from "../events.ts";
import { log } from "../log.ts";
import { classify } from "../process/classify.ts";
import { articleTerms, assignCluster } from "../process/cluster.ts";
import { rerank } from "../process/rank.ts";
import {
  canonicalizeUrl, extractEntities, fingerprint, simhash, titleKey, truncate, urlKey,
} from "../process/text.ts";
import { matchTopics } from "../process/topics.ts";
import { CORRECTION_PATTERN, RETRACTION_PATTERN } from "../process/taxonomy.ts";
import { FetchError, checkRobots, fetchText } from "./fetcher.ts";
import { FeedParseError, parseFeed, type FeedItem, type ParsedFeed } from "./parser.ts";

// The ingestion pipeline. Stages: retrieve -> validate -> normalize -> dedupe -> classify
// -> cluster -> store -> rank -> notify listeners. Each stage records its outcome.

export interface SourceRow {
  id: number;
  slug: string;
  name: string;
  feed_url: string;
  category: string;
  kind: string;
  region: string | null;
  language: string;
  interval_minutes: number;
  etag: string | null;
  last_modified: string | null;
  consecutive_failures: number;
  admin_disabled: number;
}

export interface ItemStats {
  found: number;
  new: number;
  updated: number;
  duplicate: number;
  invalid: number;
  newArticleIds: number[];
  touchedClusters: number[];
}

/** Process parsed feed items for one source. Pure database work; no network. */
export function processItems(source: SourceRow, items: FeedItem[]): ItemStats {
  const stats: ItemStats = { found: items.length, new: 0, updated: 0, duplicate: 0, invalid: 0, newArticleIds: [], touchedClusters: [] };
  const touched = new Set<number>();
  const now = nowIso();

  // Oldest first so that clusters build up in publication order.
  const ordered = [...items].sort((a, b) => (a.publishedAt?.getTime() ?? 0) - (b.publishedAt?.getTime() ?? 0));

  for (const item of ordered) {
    try {
      const title = truncate(item.title || item.description, 300);
      if (!item.url || !title) {
        stats.invalid++;
        continue;
      }
      const canonical = canonicalizeUrl(item.url);
      const key = urlKey(item.url);
      const tKey = titleKey(title);
      const description = truncate(item.description || "", 1200);
      const contentText = item.contentText && item.contentText.length > description.length + 200 ? item.contentText.slice(0, 20000) : "";
      const fp = fingerprint(title, description || contentText);

      // ---- Deduplication -------------------------------------------------------------
      const existing =
        get<any>("SELECT * FROM articles WHERE source_id = ? AND url_key = ?", source.id, key) ??
        (item.guid ? get<any>("SELECT * FROM articles WHERE source_id = ? AND guid = ?", source.id, item.guid) : undefined);

      if (existing) {
        const changed = updateExisting(existing, { title, description, contentText, item });
        if (changed.meaningful) {
          stats.updated++;
          if (existing.cluster_id) touched.add(existing.cluster_id);
        } else {
          stats.duplicate++;
        }
        continue;
      }

      const sameAcrossSources = get<{ id: number; source_id: number }>("SELECT id, source_id FROM articles WHERE url_key = ? LIMIT 1", key);
      if (sameAcrossSources) {
        // Another feed already gave us this exact article (e.g. an aggregator linking to it).
        logDuplicate(source.id, canonical, title, sameAcrossSources.id, "url");
        stats.duplicate++;
        continue;
      }
      const since48 = new Date(Date.now() - 48 * 3600_000).toISOString();
      const sameTitle = get<{ id: number }>(
        "SELECT id FROM articles WHERE source_id = ? AND title_key = ? AND retrieved_at >= ? LIMIT 1",
        source.id, tKey, since48,
      );
      if (sameTitle && tKey.length > 15) {
        logDuplicate(source.id, canonical, title, sameTitle.id, "title");
        stats.duplicate++;
        continue;
      }
      const sameFp = get<{ id: number }>("SELECT id FROM articles WHERE source_id = ? AND fingerprint = ? LIMIT 1", source.id, fp);
      if (sameFp) {
        logDuplicate(source.id, canonical, title, sameFp.id, "fingerprint");
        stats.duplicate++;
        continue;
      }

      // ---- Normalize + classify --------------------------------------------------------
      const published = item.publishedAt ?? item.updatedAt;
      const publishedAt = (published ?? new Date()).toISOString();
      const cls = classify({
        title,
        description,
        url: canonical,
        sourceCategory: source.category,
        sourceKind: source.kind,
        sourceRegion: source.region,
      });
      const fullText = `${title}. ${description}`;
      const termList = articleTerms(title, description);
      const entities = extractEntities(`${title}. ${description}`);
      const sh = simhash(`${title} ${description}`);
      const topics = matchTopics(fullText, cls.category);
      const correction = RETRACTION_PATTERN.test(fullText) ? "retracted" : CORRECTION_PATTERN.test(fullText) ? "corrected" : "none";

      const articleId = tx(() => {
        const r = run(
          `INSERT INTO articles (source_id, guid, canonical_url, url_key, headline, original_headline, title_key, author, description,
             content, content_basis, image_url, published_at, published_at_estimated, feed_updated_at, retrieved_at,
             last_meaningful_update_at, category, category_method, topics, geo, article_type, language, fingerprint, simhash,
             terms, entities, correction_status, processing_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'rules', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'classified')`,
          source.id, item.guid, canonical, key, title, item.title || title, tKey, item.author, description || null,
          contentText || null, contentText ? "full_feed_text" : description ? "excerpt" : "none", item.imageUrl,
          publishedAt, published ? 0 : 1, item.updatedAt?.toISOString() ?? null, now, publishedAt,
          cls.category, json(topics), json(cls.geo), cls.articleType, source.language, fp, sh, json(termList),
          json(entities), correction,
        );
        const id = Number(r.lastInsertRowid);
        run(
          "INSERT INTO articles_fts (rowid, headline, description, content, source_name) VALUES (?, ?, ?, ?, ?)",
          id, title, description, contentText.slice(0, 5000), source.name,
        );
        const assignment = assignCluster({
          id, sourceId: source.id, sourceKind: source.kind, title, description, termList, entities, simhash: sh,
          publishedAt, category: cls.category, articleType: cls.articleType,
        });
        touched.add(assignment.clusterId);
        return id;
      });
      stats.new++;
      stats.newArticleIds.push(articleId);
    } catch (e: any) {
      stats.invalid++;
      log("error", "ingest", `Failed to process item from ${source.name}`, { sourceId: source.id, url: item.url, error: e?.message });
    }
  }

  if (touched.size) rerank([...touched]);
  stats.touchedClusters = [...touched];
  return stats;
}

function logDuplicate(sourceId: number, url: string, title: string, matched: number, method: string) {
  run(
    "INSERT INTO duplicate_log (at, source_id, candidate_url, candidate_title, matched_article_id, method, action) VALUES (?, ?, ?, ?, ?, ?, 'skipped')",
    nowIso(), sourceId, url, title, matched, method,
  );
}

/** Detect and record meaningful changes to an article we already have. */
function updateExisting(
  existing: any,
  next: { title: string; description: string; contentText: string; item: FeedItem },
): { meaningful: boolean } {
  const now = nowIso();
  const changes: { field: string; old: string | null; new: string | null; significant: boolean }[] = [];
  if (next.title && next.title !== existing.headline) {
    const significant = titleKey(next.title) !== existing.title_key;
    changes.push({ field: "headline", old: existing.headline, new: next.title, significant });
  }
  if (next.description && next.description !== (existing.description ?? "")) {
    const oldLen = (existing.description ?? "").length;
    const significant = Math.abs(next.description.length - oldLen) > 80 || CORRECTION_PATTERN.test(next.description);
    changes.push({ field: "description", old: existing.description, new: next.description, significant });
  }
  if (!changes.length) return { meaningful: false };

  const meaningful = changes.some((c) => c.significant);
  const correction = CORRECTION_PATTERN.test(`${next.title} ${next.description}`);
  tx(() => {
    for (const c of changes) {
      run(
        "INSERT INTO article_revisions (article_id, at, field, old_value, new_value, significant) VALUES (?, ?, ?, ?, ?, ?)",
        existing.id, now, c.field, c.old, c.new, c.significant ? 1 : 0,
      );
    }
    run(
      `UPDATE articles SET headline = ?, title_key = ?, description = ?, feed_updated_at = ?,
         last_meaningful_update_at = CASE WHEN ? THEN ? ELSE last_meaningful_update_at END,
         correction_status = CASE WHEN ? THEN (CASE WHEN ? THEN 'retracted' ELSE 'corrected' END)
                                  WHEN ? THEN 'updated' ELSE correction_status END
       WHERE id = ?`,
      next.title || existing.headline, titleKey(next.title || existing.headline), next.description || existing.description,
      next.item.updatedAt?.toISOString() ?? existing.feed_updated_at,
      meaningful ? 1 : 0, now,
      correction ? 1 : 0, RETRACTION_PATTERN.test(`${next.title} ${next.description}`) ? 1 : 0,
      meaningful ? 1 : 0,
      existing.id,
    );
    run("UPDATE articles_fts SET headline = ?, description = ? WHERE rowid = ?", next.title || existing.headline, next.description || existing.description || "", existing.id);
    if (meaningful && existing.cluster_id) {
      const kind = correction ? (RETRACTION_PATTERN.test(next.title + next.description) ? "retraction" : "correction") : "update";
      const sourceName = get<{ name: string }>("SELECT name FROM sources WHERE id = ?", existing.source_id)?.name ?? "Source";
      run(
        "INSERT INTO cluster_events (cluster_id, at, observed_at, kind, article_id, text, significant) VALUES (?, ?, ?, ?, ?, ?, 1)",
        existing.cluster_id, now, now, kind, existing.id,
        kind === "update" ? `${sourceName} updated its report: ${next.title}` : `${sourceName} published a ${kind}: ${next.title}`,
      );
      run("UPDATE clusters SET last_update_at = ?, needs_resummary = 1 WHERE id = ?", now, existing.cluster_id);
    }
  });
  return { meaningful };
}

// ---- Source-level ingestion ---------------------------------------------------------

export interface IngestOutcome {
  status: "ok" | "not_modified" | "error";
  stats?: ItemStats;
  error?: string;
  httpStatus?: number;
  retryAfterSec?: number;
}

export async function ingestSource(sourceId: number, trigger: "schedule" | "manual" | "validation" | "retry", retryCount = 0): Promise<IngestOutcome> {
  const source = get<SourceRow>("SELECT * FROM sources WHERE id = ?", sourceId);
  if (!source) return { status: "error", error: "Source not found" };
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const job = run(
    "INSERT INTO ingest_jobs (source_id, trigger, started_at, status, retry_count) VALUES (?, ?, ?, 'running', ?)",
    source.id, trigger, startedAt, retryCount,
  );
  const jobId = Number(job.lastInsertRowid);
  run("UPDATE sources SET last_attempt_at = ? WHERE id = ?", startedAt, source.id);

  try {
    if (!(await checkRobots(source.feed_url))) {
      throw new FetchError("The publisher's robots.txt disallows automated access to this feed.", "robots");
    }
    const res = await fetchText(source.feed_url, { etag: source.etag, lastModified: source.last_modified });
    if (res.notModified) {
      finishJob(jobId, started, { status: "not_modified", http: 304 });
      markSuccess(source, null, null, null, 0);
      return { status: "not_modified" };
    }
    const feed = parseFeed(res.body, res.finalUrl);
    if (!feed.items.length) {
      log("warn", "ingest", `${source.name} returned a valid feed with no items`, { sourceId: source.id });
    }
    const stats = processItems(source, feed.items);
    finishJob(jobId, started, { status: "ok", http: res.status, stats });
    markSuccess(source, res.etag, res.lastModified, feed, stats.new);
    if (stats.new || stats.updated) {
      emit({ type: "articles", newCount: stats.new, updatedCount: stats.updated, sourceId: source.id, clusterIds: stats.touchedClusters });
    }
    emit({ type: "source", sourceId: source.id, status: "ok" });
    return { status: "ok", stats, httpStatus: res.status };
  } catch (e: any) {
    const message =
      e instanceof FetchError || e instanceof FeedParseError ? e.message : `Unexpected error: ${e?.message ?? String(e)}`;
    const httpStatus = e instanceof FetchError ? e.status : undefined;
    finishJob(jobId, started, { status: "error", http: httpStatus ?? null, error: message });
    markFailure(source, message, httpStatus, e instanceof FetchError ? e.retryAfterSec : undefined, e instanceof FetchError && e.code === "robots");
    log("warn", "ingest", `Fetch failed for ${source.name}: ${message}`, { sourceId: source.id, httpStatus, trigger });
    emit({ type: "source", sourceId: source.id, status: "error" });
    return { status: "error", error: message, httpStatus, retryAfterSec: e instanceof FetchError ? e.retryAfterSec : undefined };
  }
}

function finishJob(jobId: number, started: number, r: { status: string; http: number | null; stats?: ItemStats; error?: string }) {
  run(
    `UPDATE ingest_jobs SET finished_at = ?, status = ?, http_status = ?, items_found = ?, items_new = ?, items_updated = ?,
       items_duplicate = ?, items_invalid = ?, duration_ms = ?, error = ? WHERE id = ?`,
    nowIso(), r.status, r.http, r.stats?.found ?? 0, r.stats?.new ?? 0, r.stats?.updated ?? 0, r.stats?.duplicate ?? 0,
    r.stats?.invalid ?? 0, Date.now() - started, r.error ?? null, jobId,
  );
}

/** Adaptive schedule: slow feeds are polled less often, busy feeds closer to their configured interval. */
export function nextInterval(source: { interval_minutes: number }, observedPerDay: number | null, feedTtl: number | null): number {
  let minutes = source.interval_minutes;
  if (observedPerDay != null) {
    if (observedPerDay < 2) minutes = Math.max(minutes, 180);
    else if (observedPerDay < 8) minutes = Math.max(minutes, 60);
  }
  if (feedTtl && feedTtl > minutes) minutes = Math.min(feedTtl, 360);
  return minutes;
}

function markSuccess(source: SourceRow, etag: string | null, lastModified: string | null, feed: ParsedFeed | null, newItems: number) {
  const now = new Date();
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const count = get<{ n: number; first: string | null }>(
    "SELECT COUNT(*) AS n, MIN(retrieved_at) AS first FROM articles WHERE source_id = ? AND published_at >= ?",
    source.id, since,
  )!;
  const days = count.first ? Math.max(1, (Date.now() - Date.parse(count.first)) / 86_400_000) : null;
  const perDay = days ? count.n / Math.min(7, days) : null;
  const interval = nextInterval(source, days && days >= 1 ? perDay : null, feed?.ttlMinutes ?? null);
  run(
    `UPDATE sources SET status = 'ok', last_success_at = ?, last_error = NULL, last_http_status = 200, consecutive_failures = 0,
       etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified), next_fetch_at = ?,
       last_new_item_at = CASE WHEN ? > 0 THEN ? ELSE last_new_item_at END,
       integration = COALESCE(?, integration),
       article_count = (SELECT COUNT(*) FROM articles WHERE source_id = sources.id),
       observed_items_per_day = ?
     WHERE id = ?`,
    now.toISOString(), etag, lastModified, new Date(now.getTime() + interval * 60_000).toISOString(),
    newItems, now.toISOString(), feed?.format ?? null, perDay, source.id,
  );
}

function markFailure(source: SourceRow, message: string, httpStatus: number | undefined, retryAfterSec: number | undefined, permanent: boolean) {
  const failures = source.consecutive_failures + 1;
  // Exponential backoff: 2, 4, 8 ... minutes, capped at 6 hours; honour Retry-After.
  let backoffMin = Math.min(360, 2 ** Math.min(failures, 9));
  if (retryAfterSec) backoffMin = Math.max(backoffMin, Math.ceil(retryAfterSec / 60));
  if (permanent || httpStatus === 404 || httpStatus === 410) backoffMin = Math.max(backoffMin, 360);
  const status = failures >= 3 ? "error" : "degraded";
  run(
    `UPDATE sources SET status = ?, last_error = ?, last_http_status = ?, consecutive_failures = ?, next_fetch_at = ? WHERE id = ?`,
    status, message, httpStatus ?? null, failures, new Date(Date.now() + backoffMin * 60_000).toISOString(), source.id,
  );
}

// ---- Validation for the Add Source workflow -----------------------------------------

export interface ValidationReport {
  ok: boolean;
  checks: { key: string; label: string; ok: boolean; detail: string }[];
  feed?: { title: string; siteUrl: string | null; description: string; format: string; itemCount: number; sample: { title: string; url: string; publishedAt: string | null }[] };
  duplicateOf?: { id: number; name: string };
  discoveredFeedUrl?: string;
}

export async function validateFeedUrl(rawUrl: string): Promise<ValidationReport> {
  const checks: ValidationReport["checks"] = [];
  const add = (key: string, label: string, ok: boolean, detail: string) => checks.push({ key, label, ok, detail });

  let url = rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

  const dupe = get<{ id: number; name: string }>("SELECT id, name FROM sources WHERE feed_url = ? OR feed_url = ?", url, canonicalizeUrl(url));
  if (dupe) {
    add("duplicate", "Not already registered", false, `This feed is already registered as “${dupe.name}”.`);
    return { ok: false, checks, duplicateOf: dupe };
  }
  add("duplicate", "Not already registered", true, "No existing source uses this URL.");

  let res;
  try {
    if (!(await checkRobots(url))) {
      add("reachable", "Reachable", false, "The publisher's robots.txt disallows automated access to this URL.");
      return { ok: false, checks };
    }
    res = await fetchText(url);
    add("reachable", "Reachable", true, `HTTP ${res.status}, ${Math.round(res.bytes / 1024)} KB.`);
  } catch (e: any) {
    const auth = e instanceof FetchError && (e.status === 401 || e.status === 403);
    add("reachable", "Reachable", false, e?.message ?? "Request failed.");
    if (auth) add("auth", "No authentication required", false, "The server refused the request; this source likely needs credentials or blocks automated readers.");
    return { ok: false, checks };
  }
  add("auth", "No authentication required", true, "The feed was served without credentials.");

  let feed: ParsedFeed;
  try {
    feed = parseFeed(res.body, res.finalUrl);
  } catch (e: any) {
    // A web page: try feed autodiscovery via <link rel="alternate">.
    const discovered = discoverFeedLink(res.body, res.finalUrl);
    if (discovered && discovered !== url) {
      add("format", "Valid RSS/Atom feed", false, `This is a web page. It advertises a feed at ${discovered}; validating that instead.`);
      const inner = await validateFeedUrl(discovered);
      return { ...inner, discoveredFeedUrl: inner.discoveredFeedUrl ?? discovered, checks: [...checks, ...inner.checks.filter((c) => c.key !== "duplicate")] };
    }
    add("format", "Valid RSS/Atom feed", false, e?.message ?? "Not a feed.");
    return { ok: false, checks };
  }
  add("format", "Valid RSS/Atom feed", true, `${feed.format.toUpperCase()} feed “${feed.title || "untitled"}”.`);

  const withLinks = feed.items.filter((i) => i.url && i.title);
  add("articles", "Articles can be extracted", withLinks.length > 0, `${withLinks.length} of ${feed.items.length} items have a headline and link.`);
  const withDates = feed.items.filter((i) => i.publishedAt || i.updatedAt);
  const datesOk = feed.items.length > 0 && withDates.length / feed.items.length >= 0.5;
  add(
    "timestamps",
    "Timestamps available",
    datesOk,
    datesOk
      ? `${withDates.length} of ${feed.items.length} items have publication dates.`
      : "Most items have no publication date; retrieval time would have to be used and would be marked as estimated.",
  );

  return {
    ok: withLinks.length > 0,
    checks,
    feed: {
      title: feed.title,
      siteUrl: feed.siteUrl,
      description: feed.description,
      format: feed.format,
      itemCount: feed.items.length,
      sample: withLinks.slice(0, 5).map((i) => ({ title: i.title, url: i.url, publishedAt: i.publishedAt?.toISOString() ?? null })),
    },
    discoveredFeedUrl: res.finalUrl !== url ? res.finalUrl : undefined,
  };
}

function discoverFeedLink(html: string, base: string): string | null {
  const re = /<link\b[^>]*>/gi;
  for (const m of html.matchAll(re)) {
    const tag = m[0];
    if (!/rel=["']?alternate/i.test(tag)) continue;
    if (!/type=["']?application\/(rss|atom)\+xml/i.test(tag)) continue;
    const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
    if (href) {
      try {
        return new URL(href, base).toString();
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

export function sourcesDueForFetch(limit = 50) {
  // A source is ingested only if the admin hasn't disabled it and at least one reader has it
  // enabled (or it is on by default for readers who haven't customized it).
  return all<{ id: number }>(
    `SELECT s.id FROM sources s
     WHERE s.admin_disabled = 0
       AND (s.next_fetch_at IS NULL OR s.next_fetch_at <= ?)
       AND (
         EXISTS (SELECT 1 FROM user_sources us WHERE us.source_id = s.id AND us.enabled = 1)
         OR (s.default_enabled = 1 AND EXISTS (SELECT 1 FROM users u WHERE NOT EXISTS (SELECT 1 FROM user_sources us2 WHERE us2.user_id = u.id AND us2.source_id = s.id)))
         OR (s.default_enabled = 1 AND NOT EXISTS (SELECT 1 FROM users))
       )
     ORDER BY s.priority DESC, COALESCE(s.next_fetch_at, '') ASC
     LIMIT ?`,
    nowIso(), limit,
  );
}

export function sourceHealth() {
  return all<any>("SELECT id, name, status, last_success_at, last_attempt_at, last_error, consecutive_failures FROM sources");
}

export { parseJson };
