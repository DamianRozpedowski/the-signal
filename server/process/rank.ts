import { all, get, json, kvGet, kvSet, nowIso, parseJson, run } from "../db.ts";
import { independentSourceCount } from "./cluster.ts";
import { CATEGORIES, IMPACT_SIGNALS } from "./taxonomy.ts";

// Explainable editorial ranking. Every component is bounded and contributes a reason
// label, so readers can see why a story was elevated. Recency and coverage volume are
// supporting signals only: together they cannot outweigh substantive impact.

export interface RankingWeights {
  coverage: number;   // max points for independent corroboration
  impact: number;     // max points for impact signals
  official: number;   // official-source involvement
  development: number;// recent meaningful development
  recency: number;    // max freshness points
  hardNews: number;   // bonus for hard-news categories
  softNews: number;   // penalty for soft-news categories
  opinionOnly: number;// penalty when coverage is only opinion/commentary
}

export const DEFAULT_WEIGHTS: RankingWeights = {
  coverage: 26, impact: 30, official: 8, development: 10, recency: 18, hardNews: 6, softNews: -6, opinionOnly: -18,
};

export function getWeights(): RankingWeights {
  return { ...DEFAULT_WEIGHTS, ...kvGet<Partial<RankingWeights>>("ranking_weights", {}) };
}
export function setWeights(w: Partial<RankingWeights>) {
  kvSet("ranking_weights", w);
}

const impactRegexes = IMPACT_SIGNALS.map((s) => ({
  ...s,
  res: s.terms.map((t) => new RegExp(`(^|[^a-z])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i")),
}));

export function impactSignals(text: string): { label: string; weight: number }[] {
  const out: { label: string; weight: number }[] = [];
  for (const s of impactRegexes) if (s.res.some((r) => r.test(text))) out.push({ label: s.label, weight: s.weight });
  return out.sort((a, b) => b.weight - a.weight);
}

export interface RankResult {
  score: number;
  reasons: { label: string; points: number }[];
  independent: number;
}

export function scoreCluster(clusterId: number, now = Date.now(), w = getWeights()): RankResult | null {
  const c = get<any>("SELECT * FROM clusters WHERE id = ?", clusterId);
  if (!c) return null;
  const arts = all<{ headline: string; description: string | null; article_type: string; kind: string }>(
    "SELECT a.headline, a.description, a.article_type, s.kind FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.cluster_id = ?",
    clusterId,
  );
  const reasons: { label: string; points: number }[] = [];
  const { independent } = independentSourceCount(clusterId);

  // 1. Corroboration by independent sources (log-scaled; 8+ sources saturates).
  const cov = Math.min(1, Math.log2(1 + independent) / Math.log2(9)) * w.coverage;
  if (independent >= 2) reasons.push({ label: `Reported by ${independent} independent sources`, points: cov });

  // 2. Impact: strongest signal at full weight, a second distinct signal at half.
  // Headlines are matched; descriptions only count when the signal also appears in 2+ articles.
  const headText = arts.map((a) => a.headline).join(" \n ");
  const signals = impactSignals(headText);
  for (const s of impactSignals(arts.map((a) => a.description ?? "").join(" \n "))) {
    const supporting = arts.filter((a) => impactSignals(`${a.headline} ${a.description ?? ""}`).some((x) => x.label === s.label)).length;
    if (supporting >= 2 && !signals.some((x) => x.label === s.label)) signals.push({ ...s, weight: s.weight * 0.7 });
  }
  signals.sort((a, b) => b.weight - a.weight);
  let impact = 0;
  signals.slice(0, 2).forEach((s, i) => {
    const pts = (s.weight / 14) * (w.impact / 2) * (i === 0 ? 1.4 : 0.6);
    impact += pts;
    reasons.push({ label: s.label, points: pts });
  });
  impact = Math.min(impact, w.impact);

  // 3. Official involvement (primary sources).
  const official = c.has_official ? w.official : 0;
  if (official) reasons.push({ label: "Includes an official statement or release", points: official });

  // 4. Meaningful development in an ongoing story within the last 6 hours.
  const recentDev = get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM cluster_events WHERE cluster_id = ? AND significant = 1 AND kind != 'first_report' AND at >= ?",
    clusterId,
    new Date(now - 6 * 3600_000).toISOString(),
  )!.n;
  const development = recentDev ? Math.min(w.development, 5 + recentDev * 2.5) : 0;
  if (development) reasons.push({ label: "New development in an ongoing story", points: development });

  // 5. Recency of the last meaningful update (half-life ~10h).
  const ageH = Math.max(0, (now - Date.parse(c.last_update_at)) / 3600_000);
  const recency = w.recency * Math.exp(-ageH / 14);

  // 6. Category and article-type adjustments.
  const cat = CATEGORIES.find((x) => x.key === c.category);
  const catAdj = cat?.hard ? w.hardNews : ["sports", "entertainment", "culture"].includes(c.category) ? w.softNews : 0;
  const opinionOnly = arts.length > 0 && arts.every((a) => a.article_type === "opinion" || a.article_type === "analysis");
  const opinionAdj = opinionOnly ? w.opinionOnly : 0;
  if (opinionOnly) reasons.push({ label: "Commentary or analysis only", points: opinionAdj });

  const raw = cov + impact + official + development + recency + catAdj + opinionAdj;
  const score = Math.max(0, Math.min(100, Math.round(raw * 10) / 10));
  reasons.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  return { score, reasons, independent };
}

const BREAKING_WINDOW_H = 3;
const BREAKING_TTL_H = 6;

/**
 * Re-rank the given clusters and update breaking/developing/quiet status.
 * Breaking is set once, only for a significant, recent, corroborated (or official) event,
 * and is never re-applied because more articles about the same event arrive.
 */
export function rerank(clusterIds: number[], now = Date.now()) {
  const w = getWeights();
  for (const id of clusterIds) {
    const r = scoreCluster(id, now, w);
    if (!r) continue;
    const c = get<any>("SELECT * FROM clusters WHERE id = ?", id);
    const firstPub = Date.parse(c.first_published_at ?? c.first_seen_at);
    const firstSeen = Date.parse(c.first_seen_at);
    const reasonsHaveImpact = r.reasons.some((x) => IMPACT_SIGNALS.some((s) => s.label === x.label));
    let breakingAt: string | null = c.breaking_at;
    if (
      !breakingAt &&
      now - Math.max(firstPub, firstSeen - 3600_000) <= BREAKING_WINDOW_H * 3600_000 &&
      r.score >= 52 &&
      reasonsHaveImpact &&
      (r.independent >= 2 || c.has_official)
    ) {
      breakingAt = new Date(now).toISOString();
    }
    const isBreaking = breakingAt && now - Date.parse(breakingAt) <= BREAKING_TTL_H * 3600_000 ? 1 : 0;

    const spanH = (Date.parse(c.last_update_at) - firstPub) / 3600_000;
    const sinceUpdateH = (now - Date.parse(c.last_update_at)) / 3600_000;
    const sigEvents = get<{ n: number }>("SELECT COUNT(*) AS n FROM cluster_events WHERE cluster_id = ? AND significant = 1", id)!.n;
    let status = "active";
    if (sinceUpdateH > 36) status = "quiet";
    else if (sigEvents >= 2 && spanH >= 1.5 && sinceUpdateH <= 12 && c.article_count >= 3) status = "developing";

    run(
      "UPDATE clusters SET importance = ?, importance_reasons = ?, is_breaking = ?, breaking_at = ?, status = CASE WHEN status = 'resolved' THEN status ELSE ? END WHERE id = ?",
      r.score,
      json(r.reasons.map((x) => ({ label: x.label, points: Math.round(x.points * 10) / 10 }))),
      isBreaking,
      breakingAt,
      status,
      id,
    );
  }
}

/** Periodic sweep so recency decay, breaking expiry and quiet status stay current. */
export function rerankRecent() {
  const since = new Date(Date.now() - 4 * 86_400_000).toISOString();
  const ids = all<{ id: number }>("SELECT id FROM clusters WHERE last_article_at >= ? OR is_breaking = 1", since).map((r) => r.id);
  rerank(ids);
  run("UPDATE clusters SET is_breaking = 0 WHERE is_breaking = 1 AND breaking_at < ?", new Date(Date.now() - BREAKING_TTL_H * 3600_000).toISOString());
  kvSet("last_rerank_at", nowIso());
  return ids.length;
}

export function parseReasons(v: string) {
  return parseJson<{ label: string; points: number }[]>(v, []);
}
