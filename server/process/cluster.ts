import { all, get, json, nowIso, parseJson, run } from "../db.ts";
import { CORRECTION_PATTERN, DEVELOPMENT_TERMS, RETRACTION_PATTERN } from "./taxonomy.ts";
import { cosine, hamming, jaccard, terms as toTerms, termFreq } from "./text.ts";

// Story clustering. Each new article is compared with recent articles (72h window) using
// TF-IDF cosine similarity over headline+description terms plus shared named entities.
// Assignment requires both a strong best match and reasonable average similarity to the
// cluster, which prevents long chains of loosely related stories from merging.

const WINDOW_MS = 72 * 3600_000;
export const CLUSTER_THRESHOLD = 0.34;

interface Doc {
  id: number;
  clusterId: number | null;
  sourceId: number;
  publishedAt: number;
  vec: Map<string, number>;
  entities: string[];
  simhash: string;
}

const docs = new Map<number, Doc>();
const inverted = new Map<string, Set<number>>();
const docFreq = new Map<string, number>();
let totalDocs = 0;

function idf(term: string) {
  return Math.log((totalDocs + 1) / ((docFreq.get(term) ?? 0) + 1)) + 1;
}

/** Weighted term list for an article: headline terms count double. */
export function articleTerms(title: string, description: string): string[] {
  return [...toTerms(title), ...toTerms(title), ...toTerms(description).slice(0, 80)];
}

function vectorize(termList: string[]): Map<string, number> {
  const tf = termFreq(termList);
  const v = new Map<string, number>();
  for (const [t, c] of tf) v.set(t, (1 + Math.log(c)) * idf(t));
  // keep the 30 strongest terms
  return new Map([...v.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30));
}

function addDoc(d: Doc, termList: string[]) {
  docs.set(d.id, d);
  for (const t of new Set(termList)) {
    docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  }
  totalDocs++;
  for (const t of d.vec.keys()) {
    let s = inverted.get(t);
    if (!s) inverted.set(t, (s = new Set()));
    s.add(d.id);
  }
}

export function removeDoc(id: number) {
  const d = docs.get(id);
  if (!d) return;
  for (const t of d.vec.keys()) inverted.get(t)?.delete(id);
  docs.delete(id);
}

/** Rebuild the in-memory index from the database (startup, and hourly to expire old docs). */
export function rebuildIndex() {
  docs.clear();
  inverted.clear();
  docFreq.clear();
  totalDocs = 0;
  // Document frequencies from the last 7 days give stable IDF weights.
  const since7 = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const rows = all<{ terms: string }>("SELECT terms FROM articles WHERE retrieved_at >= ?", since7);
  for (const r of rows) {
    for (const t of new Set(parseJson<string[]>(r.terms, []))) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
    totalDocs++;
  }
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const recent = all<any>(
    "SELECT id, cluster_id, source_id, published_at, terms, entities, simhash FROM articles WHERE published_at >= ? OR retrieved_at >= ?",
    since,
    since,
  );
  for (const r of recent) {
    const termList = parseJson<string[]>(r.terms, []);
    const d: Doc = {
      id: r.id,
      clusterId: r.cluster_id,
      sourceId: r.source_id,
      publishedAt: Date.parse(r.published_at),
      vec: vectorize(termList),
      entities: parseJson<string[]>(r.entities, []),
      simhash: r.simhash,
    };
    docs.set(d.id, d);
    for (const t of d.vec.keys()) {
      let s = inverted.get(t);
      if (!s) inverted.set(t, (s = new Set()));
      s.add(d.id);
    }
  }
}

export function similarity(a: { vec: Map<string, number>; entities: string[] }, b: { vec: Map<string, number>; entities: string[] }) {
  const cos = cosine(a.vec, b.vec);
  const sharedEntities = a.entities.filter((e) => b.entities.includes(e)).length;
  const ej = jaccard(a.entities, b.entities);
  // Similar wording with no shared actor/place is weak evidence of the same event.
  if (sharedEntities === 0 && cos < 0.5) return cos * 0.6;
  return Math.min(1, cos * 0.8 + ej * 0.35 + Math.min(sharedEntities, 3) * 0.03);
}

export interface ClusterAssignment {
  clusterId: number;
  created: boolean;
  matchedArticleId: number | null;
  score: number;
}

/**
 * Assign an already-inserted article to a cluster (existing or new).
 * Records timeline events and marks the cluster for re-ranking / re-summarization.
 */
export function assignCluster(article: {
  id: number;
  sourceId: number;
  sourceKind: string;
  title: string;
  description: string;
  termList: string[];
  entities: string[];
  simhash: string;
  publishedAt: string;
  category: string;
  articleType: string;
}): ClusterAssignment {
  const vec = vectorize(article.termList);
  const pub = Date.parse(article.publishedAt);
  const me = { vec, entities: article.entities };

  // Candidate retrieval through the inverted index on the strongest terms.
  const candidates = new Set<number>();
  for (const t of [...vec.keys()].slice(0, 12)) for (const id of inverted.get(t) ?? []) candidates.add(id);

  const perCluster = new Map<number, { best: number; bestId: number; scores: number[] }>();
  for (const id of candidates) {
    const d = docs.get(id);
    if (!d || d.id === article.id || d.clusterId == null) continue;
    if (Math.abs(d.publishedAt - pub) > 48 * 3600_000) continue;
    const s = similarity(me, d);
    const e = perCluster.get(d.clusterId) ?? { best: 0, bestId: d.id, scores: [] };
    e.scores.push(s);
    if (s > e.best) {
      e.best = s;
      e.bestId = d.id;
    }
    perCluster.set(d.clusterId, e);
  }

  let chosen: { clusterId: number; best: number; bestId: number } | null = null;
  for (const [clusterId, e] of perCluster) {
    if (e.best < CLUSTER_THRESHOLD) continue;
    const size = get<{ n: number }>("SELECT article_count AS n FROM clusters WHERE id = ?", clusterId)?.n ?? 1;
    // Average over members we actually compared; unseen members count as dissimilar.
    const avg = e.scores.reduce((a, b) => a + b, 0) / Math.max(e.scores.length, Math.min(size, 6));
    if (avg < CLUSTER_THRESHOLD * 0.45) continue;
    if (!chosen || e.best > chosen.best) chosen = { clusterId, best: e.best, bestId: e.bestId };
  }

  const now = nowIso();
  let clusterId: number;
  let created = false;
  if (chosen) {
    clusterId = chosen.clusterId;
  } else {
    const r = run(
      `INSERT INTO clusters (headline, category, first_seen_at, first_published_at, last_update_at, last_article_at, lead_article_id, terms, entities, updated_at, needs_resummary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      article.title,
      article.category,
      now,
      article.publishedAt,
      article.publishedAt,
      now,
      article.id,
      json([...vec.keys()].slice(0, 20)),
      json(article.entities.slice(0, 20)),
      now,
    );
    clusterId = Number(r.lastInsertRowid);
    created = true;
  }

  run("UPDATE articles SET cluster_id = ?, processing_status = 'clustered' WHERE id = ?", clusterId, article.id);
  const d: Doc = { id: article.id, clusterId, sourceId: article.sourceId, publishedAt: pub, vec, entities: article.entities, simhash: article.simhash };
  addDoc(d, article.termList);

  recordClusterEvent(clusterId, article, created);
  refreshClusterAggregates(clusterId);
  return { clusterId, created, matchedArticleId: chosen?.bestId ?? null, score: chosen?.best ?? 0 };
}

function recordClusterEvent(
  clusterId: number,
  article: { id: number; sourceId: number; sourceKind: string; title: string; description: string; termList: string[]; publishedAt: string; articleType: string },
  created: boolean,
) {
  const now = nowIso();
  const source = get<{ name: string }>("SELECT name FROM sources WHERE id = ?", article.sourceId)?.name ?? "A source";
  if (created) {
    run(
      "INSERT INTO cluster_events (cluster_id, at, observed_at, kind, article_id, text, significant) VALUES (?, ?, ?, 'first_report', ?, ?, 1)",
      clusterId, article.publishedAt, now, article.id, `${source} reports: ${article.title}`,
    );
    return;
  }

  const text = `${article.title} ${article.description}`;
  if (RETRACTION_PATTERN.test(text) || CORRECTION_PATTERN.test(text)) {
    const kind = RETRACTION_PATTERN.test(text) ? "retraction" : "correction";
    run("UPDATE articles SET correction_status = ? WHERE id = ?", kind === "retraction" ? "retracted" : "corrected", article.id);
    run(
      "INSERT INTO cluster_events (cluster_id, at, observed_at, kind, article_id, text, significant) VALUES (?, ?, ?, ?, ?, ?, 1)",
      clusterId, article.publishedAt, now, kind, article.id, `${source} published a ${kind}: ${article.title}`,
    );
    markMeaningfulUpdate(clusterId, article.publishedAt);
    return;
  }

  const priorSources = all<{ source_id: number }>("SELECT DISTINCT source_id FROM articles WHERE cluster_id = ? AND id != ?", clusterId, article.id).map((r) => r.source_id);
  const isNewSource = !priorSources.includes(article.sourceId);
  const clusterTerms = new Set(
    all<{ terms: string }>("SELECT terms FROM articles WHERE cluster_id = ? AND id != ?", clusterId, article.id).flatMap((r) => parseJson<string[]>(r.terms, [])),
  );
  const titleTerms = [...new Set(toTerms(article.title))];
  const novel = titleTerms.filter((t) => !clusterTerms.has(t));
  const lowerTitle = article.title.toLowerCase();
  const devSignal = DEVELOPMENT_TERMS.some((t) => new RegExp(`\\b${t}\\b`).test(lowerTitle));
  const significantDevelopment = (devSignal && novel.length >= 2) || novel.length >= 4;

  if (article.sourceKind === "official" || article.articleType === "official") {
    run(
      "INSERT INTO cluster_events (cluster_id, at, observed_at, kind, article_id, text, significant) VALUES (?, ?, ?, 'official', ?, ?, 1)",
      clusterId, article.publishedAt, now, article.id, `Official statement from ${source}: ${article.title}`,
    );
    markMeaningfulUpdate(clusterId, article.publishedAt);
  } else if (significantDevelopment) {
    run(
      "INSERT INTO cluster_events (cluster_id, at, observed_at, kind, article_id, text, significant) VALUES (?, ?, ?, 'update', ?, ?, 1)",
      clusterId, article.publishedAt, now, article.id, `${source}: ${article.title}`,
    );
    markMeaningfulUpdate(clusterId, article.publishedAt);
  } else if (isNewSource) {
    run(
      "INSERT INTO cluster_events (cluster_id, at, observed_at, kind, article_id, text, significant) VALUES (?, ?, ?, 'new_source', ?, ?, 0)",
      clusterId, article.publishedAt, now, article.id, `${source} also reports: ${article.title}`,
    );
  }
  // Same source, nothing new: recorded only as an article in the cluster (no timeline entry).
}

function markMeaningfulUpdate(clusterId: number, at: string) {
  run("UPDATE clusters SET last_update_at = MAX(last_update_at, ?), needs_resummary = 1 WHERE id = ?", at, clusterId);
}

/** Recompute counts, lead article, category and aggregate terms for a cluster. */
export function refreshClusterAggregates(clusterId: number) {
  const arts = all<any>(
    `SELECT a.id, a.source_id, a.headline, a.category, a.article_type, a.published_at, a.terms, a.entities, a.simhash, s.kind, s.priority
     FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.cluster_id = ? ORDER BY a.published_at`,
    clusterId,
  );
  if (!arts.length) {
    run("DELETE FROM clusters WHERE id = ?", clusterId);
    return;
  }
  const sourceIds = new Set(arts.map((a) => a.source_id));
  const hasOfficial = arts.some((a) => a.kind === "official");

  // Category: weighted vote, ignoring opinion pieces.
  const votes = new Map<string, number>();
  for (const a of arts) votes.set(a.category, (votes.get(a.category) ?? 0) + (a.article_type === "opinion" ? 0.3 : 1));
  const category = [...votes.entries()].sort((x, y) => y[1] - x[1])[0][0];

  // Lead article: the most central straight-news report (highest mean similarity to the rest),
  // breaking ties toward higher-priority sources and earlier publication.
  const vecs = arts.map((a) => ({ id: a.id, vec: vectorize(parseJson<string[]>(a.terms, [])), entities: parseJson<string[]>(a.entities, []) }));
  let lead = arts[0];
  let leadScore = -1;
  arts.forEach((a, i) => {
    const typePenalty = a.article_type === "opinion" ? 0.5 : a.article_type === "live" ? 0.85 : 1;
    let s = 0;
    vecs.forEach((v, j) => {
      if (i !== j) s += similarity(vecs[i], v);
    });
    const score = (arts.length > 1 ? s / (arts.length - 1) : 1) * typePenalty + (a.priority ?? 0) * 0.02;
    if (score > leadScore) {
      leadScore = score;
      lead = a;
    }
  });

  const termCounts = new Map<string, number>();
  const entCounts = new Map<string, number>();
  for (const a of arts) {
    for (const t of new Set(parseJson<string[]>(a.terms, []))) termCounts.set(t, (termCounts.get(t) ?? 0) + 1);
    for (const e of parseJson<string[]>(a.entities, [])) entCounts.set(e, (entCounts.get(e) ?? 0) + 1);
  }
  const topTerms = [...termCounts.entries()].sort((a, b) => b[1] * idf(b[0]) - a[1] * idf(a[0])).slice(0, 25).map(([t]) => t);
  const topEntities = [...entCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([e]) => e);

  run(
    `UPDATE clusters SET headline = ?, lead_article_id = ?, article_count = ?, source_count = ?, has_official = ?, category = ?,
       terms = ?, entities = ?, first_published_at = ?, last_article_at = ?, updated_at = ? WHERE id = ?`,
    lead.headline,
    lead.id,
    arts.length,
    sourceIds.size,
    hasOfficial ? 1 : 0,
    category,
    json(topTerms),
    json(topEntities),
    arts[0].published_at,
    nowIso(),
    nowIso(),
    clusterId,
  );
}

/**
 * Number of genuinely independent sources: distinct publishers, collapsing near-identical
 * copies (syndicated wire text) into one, since repetition is not corroboration.
 */
export function independentSourceCount(clusterId: number): { independent: number; syndicatedGroups: number[][] } {
  const arts = all<{ id: number; source_id: number; simhash: string }>(
    "SELECT id, source_id, simhash FROM articles WHERE cluster_id = ? ORDER BY published_at",
    clusterId,
  );
  const groups: { sources: Set<number>; ids: number[]; hash: string }[] = [];
  for (const a of arts) {
    const g = groups.find((g) => hamming(g.hash, a.simhash) <= 3);
    if (g) {
      g.sources.add(a.source_id);
      g.ids.push(a.id);
    } else groups.push({ sources: new Set([a.source_id]), ids: [a.id], hash: a.simhash });
  }
  // Each distinct publisher counts once; a syndicated group counts once across publishers.
  const counted = new Set<number>();
  let independent = 0;
  for (const g of groups) {
    const fresh = [...g.sources].filter((s) => !counted.has(s));
    if (!fresh.length) continue;
    independent += 1;
    for (const s of g.sources) counted.add(s);
  }
  return { independent, syndicatedGroups: groups.filter((g) => g.sources.size > 1).map((g) => g.ids) };
}

/** Recalculate a cluster from scratch: detach its articles and re-run assignment (admin tool). */
export function recalculateCluster(clusterId: number) {
  const ids = all<any>(
    `SELECT a.id, a.source_id, s.kind AS source_kind, a.headline, a.description, a.terms, a.entities, a.simhash, a.published_at, a.category, a.article_type
     FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.cluster_id = ? ORDER BY a.published_at`,
    clusterId,
  );
  for (const a of ids) removeDoc(a.id);
  run("UPDATE articles SET cluster_id = NULL WHERE cluster_id = ?", clusterId);
  run("DELETE FROM clusters WHERE id = ?", clusterId);
  const touched = new Set<number>();
  for (const a of ids) {
    const r = assignCluster({
      id: a.id, sourceId: a.source_id, sourceKind: a.source_kind, title: a.headline, description: a.description ?? "",
      termList: parseJson<string[]>(a.terms, []), entities: parseJson<string[]>(a.entities, []), simhash: a.simhash,
      publishedAt: a.published_at, category: a.category, articleType: a.article_type,
    });
    touched.add(r.clusterId);
  }
  return [...touched];
}

export function indexStats() {
  return { indexedArticles: docs.size, vocabulary: docFreq.size, totalDocs };
}
