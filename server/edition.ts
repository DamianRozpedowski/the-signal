import { getPrefs, type Prefs } from "./auth.ts";
import { all, get, kvGet, kvSet, parseJson } from "./db.ts";
import { upgradeImageUrl } from "./process/images.ts";
import { getWeights } from "./process/rank.ts";
import { categoryLabel } from "./process/taxonomy.ts";

// The reader's "active edition": stories built only from the sources this reader has
// enabled, re-scored with their personalization settings. Global importance is computed
// at ingest time; personalization is applied here at read time.

export function activeSourceIds(userId: number): number[] {
  return all<{ id: number }>(
    `SELECT s.id FROM sources s LEFT JOIN user_sources us ON us.source_id = s.id AND us.user_id = ?
     WHERE s.admin_disabled = 0 AND COALESCE(us.enabled, s.default_enabled) = 1`,
    userId,
  ).map((r) => r.id);
}

export interface StoryCard {
  id: number;
  headline: string;
  description: string | null;
  summary: string | null;
  whyItMatters: string | null;
  category: string;
  categoryLabel: string;
  importance: number;
  baseImportance: number;
  reasons: { label: string; points: number }[];
  personalReasons: string[];
  status: string;
  isBreaking: boolean;
  breakingAt: string | null;
  firstPublishedAt: string;
  lastUpdateAt: string;
  lastArticleAt: string;
  articleCount: number;
  sourceCount: number;
  hasOfficial: boolean;
  lead: {
    articleId: number;
    url: string;
    sourceId: number;
    sourceName: string;
    sourceKind: string;
    publishedAt: string;
    publishedAtEstimated: boolean;
    retrievedAt: string;
    imageUrl: string | null;
    articleType: string;
    author: string | null;
  };
  sources: { id: number; name: string }[];
  topics: number[];
  geo: string[];
  latestEvent: { kind: string; text: string; at: string } | null;
}

interface UserContext {
  userId: number;
  prefs: Prefs;
  active: Set<number>;
  followed: Map<number, string>;
  muted: Set<number>;
  sourcePriority: Map<number, number>;
}

export function userContext(userId: number): UserContext {
  const prefs = getPrefs(userId);
  const topicRows = all<{ topic_id: number; state: string; name: string }>(
    "SELECT ut.topic_id, ut.state, t.name FROM user_topics ut JOIN topics t ON t.id = ut.topic_id WHERE ut.user_id = ?",
    userId,
  );
  return {
    userId,
    prefs,
    active: new Set(activeSourceIds(userId)),
    followed: new Map(topicRows.filter((t) => t.state === "follow").map((t) => [t.topic_id, t.name])),
    muted: new Set(topicRows.filter((t) => t.state === "mute").map((t) => t.topic_id)),
    sourcePriority: new Map(
      all<{ source_id: number; priority: number }>("SELECT source_id, priority FROM user_sources WHERE user_id = ? AND priority != 0", userId).map((r) => [r.source_id, r.priority]),
    ),
  };
}

const coverageCurve = (n: number) => Math.min(1, Math.log2(1 + n) / Math.log2(9));

export interface StoryQuery {
  sinceHours?: number;
  category?: string;
  topicId?: number;
  sourceId?: number;
  clusterIds?: number[];
  status?: "developing" | "breaking";
  geoPrefix?: string;
  limit?: number;
  includeMuted?: boolean;
  sort?: "importance" | "latest";
}

/** Load stories for a reader, restricted to their active sources and personalized. */
/**
 * The best picture for a story: the article page's own lead image beats a feed thumbnail,
 * and the lead article's picture beats the rest when they are equally good.
 */
export function bestImage(arts: { id: number; image_url: string | null; page_image?: string | null }[], leadId: number): string | null {
  let best: { url: string; rank: number } | null = null;
  for (const a of arts) {
    const url = a.page_image || upgradeImageUrl(a.image_url);
    if (!url) continue;
    const rank = (a.page_image ? 2 : 0) + (a.id === leadId ? 1 : 0);
    if (!best || rank > best.rank) best = { url, rank };
  }
  return best?.url ?? null;
}

export function storiesFor(ctx: UserContext, q: StoryQuery = {}): StoryCard[] {
  if (!ctx.active.size) return [];
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q.clusterIds) {
    if (!q.clusterIds.length) return [];
    where.push(`c.id IN (${q.clusterIds.map(() => "?").join(",")})`);
    params.push(...q.clusterIds);
  } else {
    where.push("c.last_article_at >= ?");
    params.push(new Date(Date.now() - (q.sinceHours ?? 72) * 3600_000).toISOString());
  }
  if (q.category) {
    where.push("c.category = ?");
    params.push(q.category);
  }
  if (q.status === "breaking") where.push("c.is_breaking = 1");
  if (q.status === "developing") where.push("c.status = 'developing'");
  const clusters = all<any>(
    `SELECT c.* FROM clusters c WHERE ${where.join(" AND ")} ORDER BY ${q.sort === "latest" ? "c.last_update_at" : "c.importance"} DESC LIMIT 600`,
    ...params,
  );
  if (!clusters.length) return [];

  const ids = clusters.map((c) => c.id);
  const arts = all<any>(
    `SELECT a.id, a.cluster_id, a.source_id, a.canonical_url, a.headline, a.description, a.image_url, a.page_image, a.published_at, a.published_at_estimated,
            a.retrieved_at, a.article_type, a.author, a.topics, a.geo, a.simhash, s.name AS source_name, s.kind AS source_kind, s.priority
     FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.cluster_id IN (${ids.map(() => "?").join(",")})
     ORDER BY a.published_at`,
    ...ids,
  );
  const byCluster = new Map<number, any[]>();
  for (const a of arts) {
    if (!ctx.active.has(a.source_id)) continue;
    if (q.sourceId && a.source_id !== q.sourceId) continue;
    (byCluster.get(a.cluster_id) ?? byCluster.set(a.cluster_id, []).get(a.cluster_id)!).push(a);
  }
  const events = all<any>(
    `SELECT cluster_id, kind, text, at FROM cluster_events WHERE significant = 1 AND cluster_id IN (${ids.map(() => "?").join(",")}) ORDER BY at DESC`,
    ...ids,
  );
  const latestEvent = new Map<number, any>();
  for (const e of events) if (!latestEvent.has(e.cluster_id)) latestEvent.set(e.cluster_id, e);

  const w = getWeights();
  const strength = Math.max(0, Math.min(100, ctx.prefs.personalization)) / 100;
  const enabledSections = new Set(ctx.prefs.homepage.sections.filter((s) => s.enabled).map((s) => s.key));
  const loc = ctx.prefs.location?.code;
  const out: StoryCard[] = [];

  for (const c of clusters) {
    const mine = byCluster.get(c.id);
    if (!mine?.length) continue;
    const topics = [...new Set(mine.flatMap((a) => parseJson<number[]>(a.topics, [])))];
    const geo = [...new Set(mine.flatMap((a) => parseJson<string[]>(a.geo, [])))];
    if (q.topicId && !topics.includes(q.topicId)) continue;
    if (q.geoPrefix && !geo.some((g) => g === q.geoPrefix || g.startsWith(`${q.geoPrefix}-`))) continue;

    // Coverage re-scored on the reader's sources only (distinct publishers, syndicated copies collapsed).
    const distinct = new Set(mine.map((a) => a.source_id)).size;
    const baseIndependent = Math.max(1, c.source_count);
    const coverageAdj = w.coverage * (coverageCurve(Math.min(distinct, baseIndependent)) - coverageCurve(baseIndependent));
    let score = Math.max(0, c.importance + coverageAdj);

    // Personalization (bounded): followed topics, preferred categories, local relevance, source priority.
    const personalReasons: string[] = [];
    let boost = 0;
    const followedHits = topics.filter((t) => ctx.followed.has(t));
    if (followedHits.length) {
      boost += 14;
      personalReasons.push(`You follow ${followedHits.map((t) => ctx.followed.get(t)).join(", ")}`);
    }
    if (enabledSections.has(c.category)) boost += 4;
    if (loc && geo.some((g) => g === loc || g.startsWith(`${loc}-`))) {
      boost += 10;
      personalReasons.push(`Relevant to ${ctx.prefs.location!.label}`);
    }
    const pr = Math.max(0, ...mine.map((a) => ctx.sourcePriority.get(a.source_id) ?? 0));
    if (pr > 0) {
      boost += Math.min(6, pr * 3);
      personalReasons.push("From a source you prioritized");
    }
    const mutedHit = topics.some((t) => ctx.muted.has(t));
    if (mutedHit && !q.includeMuted) {
      // Muted topics are hidden unless the story is of major general significance.
      if (c.importance < 70) continue;
      personalReasons.push("Shown despite a muted topic because of its significance");
    }
    score += boost * strength;
    if (strength === 0) personalReasons.length = 0;

    // Lead article: the cluster's editorial lead if the reader has that source, else the earliest straight report.
    const lead = mine.find((a) => a.id === c.lead_article_id) ?? mine.find((a) => a.article_type === "news") ?? mine[0];
    const sources = [...new Map(mine.map((a) => [a.source_id, { id: a.source_id, name: a.source_name }])).values()];
    const ev = latestEvent.get(c.id);
    out.push({
      id: c.id,
      headline: lead.headline,
      description: lead.description,
      summary: c.summary,
      whyItMatters: c.why_it_matters,
      category: c.category,
      categoryLabel: categoryLabel(c.category),
      importance: Math.round(score * 10) / 10,
      baseImportance: c.importance,
      reasons: parseJson(c.importance_reasons, []),
      personalReasons,
      status: c.status,
      isBreaking: Boolean(c.is_breaking),
      breakingAt: c.breaking_at,
      firstPublishedAt: mine[0].published_at,
      lastUpdateAt: c.last_update_at,
      lastArticleAt: c.last_article_at,
      articleCount: mine.length,
      sourceCount: sources.length,
      hasOfficial: mine.some((a) => a.source_kind === "official"),
      lead: {
        articleId: lead.id,
        url: lead.canonical_url,
        sourceId: lead.source_id,
        sourceName: lead.source_name,
        sourceKind: lead.source_kind,
        publishedAt: lead.published_at,
        publishedAtEstimated: Boolean(lead.published_at_estimated),
        retrievedAt: lead.retrieved_at,
        imageUrl: bestImage(mine, lead.id),
        articleType: lead.article_type,
        author: lead.author,
      },
      sources,
      topics,
      geo,
      latestEvent: ev ? { kind: ev.kind, text: ev.text, at: ev.at } : null,
    });
  }

  if (q.sort === "latest") out.sort((a, b) => b.lastUpdateAt.localeCompare(a.lastUpdateAt));
  else out.sort((a, b) => b.importance - a.importance);
  return out.slice(0, q.limit ?? 200);
}

/** Choose the lead story with hysteresis so it only changes for a genuinely more consequential story. */
export function chooseLead(userId: number, ranked: StoryCard[]): StoryCard | null {
  if (!ranked.length) return null;
  // Prefer corroborated or official stories updated in the last 24h.
  const eligible = ranked.filter(
    (s) => (s.sourceCount >= 2 || s.hasOfficial) && Date.now() - Date.parse(s.lastUpdateAt) < 24 * 3600_000 && s.lead.articleType !== "opinion",
  );
  const pool = eligible.length ? eligible : ranked;
  const best = pool[0];
  const prev = kvGet<{ id: number; at: string } | null>(`lead:${userId}`, null);
  if (prev && prev.id !== best.id) {
    const current = pool.find((s) => s.id === prev.id);
    const fresh = current && Date.now() - Date.parse(current.lastUpdateAt) < 18 * 3600_000;
    if (current && fresh && best.importance - current.importance < 6) return current;
  }
  if (!prev || prev.id !== best.id) kvSet(`lead:${userId}`, { id: best.id, at: new Date().toISOString() });
  return best;
}

export function lastRefresh() {
  const r = get<{ ok: string | null; attempt: string | null }>(
    "SELECT MAX(last_success_at) AS ok, MAX(last_attempt_at) AS attempt FROM sources WHERE admin_disabled = 0",
  );
  return { lastSuccessAt: r?.ok ?? null, lastAttemptAt: r?.attempt ?? null };
}

export function sourceHealthFor(userId: number) {
  const ids = activeSourceIds(userId);
  if (!ids.length) return { total: 0, ok: 0, failing: [], pending: 0, stale: [] as { id: number; name: string; lastSuccessAt: string | null }[] };
  const rows = all<any>(
    `SELECT id, name, status, last_success_at, last_error, interval_minutes FROM sources WHERE id IN (${ids.map(() => "?").join(",")})`,
    ...ids,
  );
  const now = Date.now();
  const stale = rows.filter((r) => r.last_success_at && now - Date.parse(r.last_success_at) > Math.max(6, (r.interval_minutes / 60) * 4) * 3600_000);
  return {
    total: rows.length,
    ok: rows.filter((r) => r.status === "ok").length,
    pending: rows.filter((r) => r.status === "pending").length,
    failing: rows.filter((r) => r.status === "error" || r.status === "degraded").map((r) => ({ id: r.id, name: r.name, error: r.last_error, lastSuccessAt: r.last_success_at })),
    stale: stale.map((r) => ({ id: r.id, name: r.name, lastSuccessAt: r.last_success_at })),
  };
}
