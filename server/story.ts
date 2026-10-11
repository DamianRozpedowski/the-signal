import { config } from "./config.ts";
import { all, get, nowIso, parseJson, run } from "./db.ts";
import { bestImage, storiesFor, userContext } from "./edition.ts";
import { upgradeImageUrl } from "./process/images.ts";
import { independentSourceCount, similarity } from "./process/cluster.ts";
import { prioritizeCluster } from "./ingest/fulltext.ts";
import { extractSynthesis } from "./process/extract.ts";
import { categoryLabel } from "./process/taxonomy.ts";

// Consolidated story page data and article page data for a reader.

// The extractive synthesis only changes when articles or their full text change, so keep
// recent results instead of recomputing them on every page view and live refresh.
const extractCache = new Map<string, ReturnType<typeof extractSynthesis>>();
function cachedExtract(clusterId: number, arts: any[]) {
  const key = `${clusterId}|${arts.map((a) => `${a.id}:${a.page_status ?? ""}:${a.last_meaningful_update_at}`).join(",")}`;
  const hit = extractCache.get(key);
  if (hit !== undefined) return hit;
  const ex = extractSynthesis(arts);
  extractCache.set(key, ex);
  if (extractCache.size > 300) extractCache.delete(extractCache.keys().next().value!);
  return ex;
}

function heroImage(arts: any[], leadId: number) {
  const url = bestImage(arts, leadId);
  if (!url) return null;
  const a = arts.find((x) => x.page_image === url || upgradeImageUrl(x.image_url) === url);
  return { url, sourceName: a?.source_name ?? null, articleId: a?.id ?? null };
}

export function storyDetail(userId: number, clusterId: number, opts: { recordVisit?: boolean } = {}) {
  const c = get<any>("SELECT * FROM clusters WHERE id = ?", clusterId);
  if (!c) return null;
  const ctx = userContext(userId);
  const allArts = all<any>(
    `SELECT a.*, s.name AS source_name, s.kind AS source_kind, s.site_url AS source_site
     FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.cluster_id = ? ORDER BY a.published_at ASC`,
    clusterId,
  );
  const arts = allArts.filter((a) => ctx.active.has(a.source_id));
  const hiddenCount = allArts.length - arts.length;
  if (!arts.length) return { hidden: true as const, hiddenCount };

  const card = storiesFor(ctx, { clusterIds: [clusterId], includeMuted: true })[0];
  const visit = get<{ last_visit_at: string }>("SELECT last_visit_at FROM story_visits WHERE user_id = ? AND cluster_id = ?", userId, clusterId);
  const visibleIds = new Set(arts.map((a) => a.id));
  const events = all<any>("SELECT * FROM cluster_events WHERE cluster_id = ? ORDER BY at ASC, id ASC", clusterId).filter(
    (e) => !e.article_id || visibleIds.has(e.article_id),
  );
  const sinceVisit = visit ? events.filter((e) => e.significant && e.observed_at > visit.last_visit_at) : [];
  const newArticlesSinceVisit = visit ? arts.filter((a) => a.retrieved_at > visit.last_visit_at).length : 0;

  if (opts.recordVisit) {
    if (config.schedulerEnabled && arts.some((a) => a.page_status == null)) prioritizeCluster(clusterId);
    run(
      "INSERT INTO story_visits (user_id, cluster_id, last_visit_at) VALUES (?, ?, ?) ON CONFLICT(user_id, cluster_id) DO UPDATE SET last_visit_at = excluded.last_visit_at",
      userId, clusterId, nowIso(),
    );
    run("INSERT INTO reading_history (user_id, target_type, target_id, at) VALUES (?, 'story', ?, ?)", userId, clusterId, nowIso());
  }

  const { independent, syndicatedGroups } = independentSourceCount(clusterId);
  const following = Boolean(get("SELECT 1 FROM bookmarks WHERE user_id = ? AND target_type = 'story' AND target_id = ? AND list = 'following'", userId, clusterId));
  const saved = Boolean(get("SELECT 1 FROM bookmarks WHERE user_id = ? AND target_type = 'story' AND target_id = ? AND list = 'saved'", userId, clusterId));

  // Related stories: other clusters sharing entities/terms in the last week.
  const terms = parseJson<string[]>(c.terms, []);
  const entities = parseJson<string[]>(c.entities, []);
  const relatedCandidates = all<any>(
    "SELECT id, headline, terms, entities, category, last_update_at, importance FROM clusters WHERE id != ? AND last_article_at >= ? ORDER BY importance DESC LIMIT 300",
    clusterId, new Date(Date.now() - 7 * 86_400_000).toISOString(),
  );
  const me = { vec: new Map(terms.map((t, i) => [t, 1 / (1 + i * 0.1)])), entities };
  const related = relatedCandidates
    .map((r) => {
      const t = parseJson<string[]>(r.terms, []);
      return { r, s: similarity(me, { vec: new Map(t.map((x, i) => [x, 1 / (1 + i * 0.1)])), entities: parseJson<string[]>(r.entities, []) }) };
    })
    .filter((x) => x.s >= 0.18)
    .sort((a, b) => b.s - a.s)
    .slice(0, 12)
    .map((x) => x.r.id);
  const relatedCards = storiesFor(ctx, { clusterIds: related, includeMuted: true }).slice(0, 6);

  const coverage = parseJson<any>(c.coverage, null);
  return {
    hidden: false as const,
    hiddenCount,
    id: c.id,
    card,
    headline: card?.headline ?? c.headline,
    category: c.category,
    categoryLabel: categoryLabel(c.category),
    status: c.status,
    isBreaking: Boolean(c.is_breaking),
    importance: card?.importance ?? c.importance,
    reasons: parseJson(c.importance_reasons, []),
    personalReasons: card?.personalReasons ?? [],
    firstPublishedAt: arts[0].published_at,
    firstSeenAt: c.first_seen_at,
    lastUpdateAt: c.last_update_at,
    ai: {
      summary: c.summary,
      whyItMatters: c.why_it_matters,
      keyFacts: parseJson(c.key_facts, []),
      unresolved: parseJson(c.unresolved, []),
      disputed: parseJson(c.disputed, []),
      coverage,
      generatedAt: c.summary_at,
      model: c.summary_model,
      error: c.summary_error,
      history: parseJson(c.summary_history, []),
      stale: Boolean(c.needs_resummary),
    },
    // Without an AI synthesis, offer sentences quoted from the publishers themselves.
    extracted: c.summary ? null : cachedExtract(clusterId, arts),
    image: heroImage(arts, card?.lead.articleId ?? arts[0].id),
    corroboration: { independentSources: independent, syndicatedGroups, publishers: new Set(arts.map((a) => a.source_id)).size },
    timeline: events.map((e) => ({ id: e.id, at: e.at, observedAt: e.observed_at, kind: e.kind, text: e.text, articleId: e.article_id, significant: Boolean(e.significant) })),
    sinceLastVisit: visit ? { lastVisitAt: visit.last_visit_at, events: sinceVisit.map((e) => ({ at: e.at, kind: e.kind, text: e.text })), newArticles: newArticlesSinceVisit } : null,
    articles: arts
      .slice()
      .reverse()
      .map((a) => ({
        id: a.id,
        headline: a.headline,
        description: a.description,
        summary: a.summary,
        url: a.canonical_url,
        sourceId: a.source_id,
        sourceName: a.source_name,
        sourceKind: a.source_kind,
        author: a.author,
        publishedAt: a.published_at,
        publishedAtEstimated: Boolean(a.published_at_estimated),
        retrievedAt: a.retrieved_at,
        lastMeaningfulUpdateAt: a.last_meaningful_update_at,
        articleType: a.article_type,
        correctionStatus: a.correction_status,
        imageUrl: a.page_image || upgradeImageUrl(a.image_url),
        contentBasis: a.content_basis,
        textStatus: a.page_status ?? "pending",
        linkStatus: a.link_status,
        contribution: coverage?.contributions?.find((x: any) => x.article_id === a.id)?.contribution ?? null,
      })),
    official: arts.filter((a) => a.source_kind === "official").map((a) => ({ id: a.id, headline: a.headline, url: a.canonical_url, sourceName: a.source_name, publishedAt: a.published_at })),
    corrections: events.filter((e) => e.kind === "correction" || e.kind === "retraction").map((e) => ({ at: e.at, kind: e.kind, text: e.text, articleId: e.article_id })),
    related: relatedCards,
    following,
    saved,
    upcoming: all<any>("SELECT * FROM upcoming_events WHERE cluster_id = ? ORDER BY starts_at", clusterId),
  };
}

export function articleDetail(userId: number, articleId: number, opts: { recordVisit?: boolean } = {}) {
  const a = get<any>(
    `SELECT a.*, s.name AS source_name, s.kind AS source_kind, s.site_url AS source_site, s.feed_url AS source_feed
     FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ?`,
    articleId,
  );
  if (!a) return null;
  const ctx = userContext(userId);
  const sourceActive = ctx.active.has(a.source_id);
  if (opts.recordVisit) run("INSERT INTO reading_history (user_id, target_type, target_id, at) VALUES (?, 'article', ?, ?)", userId, articleId, nowIso());
  const topics = parseJson<number[]>(a.topics, []);
  const topicRows = topics.length ? all<any>(`SELECT id, name, slug FROM topics WHERE id IN (${topics.map(() => "?").join(",")}) AND (owner_id IS NULL OR owner_id = ?)`, ...topics, userId) : [];
  const relatedInCluster = a.cluster_id
    ? all<any>(
        `SELECT a.id, a.source_id, a.headline, a.canonical_url, a.published_at, s.name AS source_name FROM articles a JOIN sources s ON s.id = a.source_id
         WHERE a.cluster_id = ? AND a.id != ? ORDER BY a.published_at DESC LIMIT 20`,
        a.cluster_id, a.id,
      ).filter((x) => ctx.active.has(x.source_id))
    : [];
  return {
    id: a.id,
    headline: a.headline,
    originalHeadline: a.original_headline,
    description: a.description,
    content: a.content_basis === "full_feed_text" ? a.content : null,
    contentBasis: a.content_basis,
    summary: a.summary,
    summaryAt: a.summary_at,
    summaryModel: a.summary_model,
    summaryBasis: a.summary_basis,
    reviewStatus: a.review_status,
    url: a.canonical_url,
    imageUrl: a.page_image || upgradeImageUrl(a.image_url),
    author: a.author,
    source: { id: a.source_id, name: a.source_name, kind: a.source_kind, siteUrl: a.source_site, active: sourceActive },
    publishedAt: a.published_at,
    publishedAtEstimated: Boolean(a.published_at_estimated),
    retrievedAt: a.retrieved_at,
    lastMeaningfulUpdateAt: a.last_meaningful_update_at,
    feedUpdatedAt: a.feed_updated_at,
    category: a.category,
    categoryLabel: categoryLabel(a.category),
    topics: topicRows,
    geo: parseJson(a.geo, []),
    articleType: a.article_type,
    correctionStatus: a.correction_status,
    linkStatus: a.link_status,
    clusterId: a.cluster_id,
    related: relatedInCluster.map((r) => ({ id: r.id, headline: r.headline, url: r.canonical_url, publishedAt: r.published_at, sourceName: r.source_name })),
    revisions: all<any>("SELECT at, field, old_value, new_value, significant FROM article_revisions WHERE article_id = ? ORDER BY at DESC", a.id),
    saved: Boolean(get("SELECT 1 FROM bookmarks WHERE user_id = ? AND target_type = 'article' AND target_id = ? AND list = 'saved'", userId, a.id)),
    readLater: Boolean(get("SELECT 1 FROM bookmarks WHERE user_id = ? AND target_type = 'article' AND target_id = ? AND list = 'later'", userId, a.id)),
  };
}
