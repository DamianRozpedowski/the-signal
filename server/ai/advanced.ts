import { z } from "zod";
import { all, get, kvGet, kvSet, parseJson } from "../db.ts";
import { activeSourceIds, storiesFor, userContext } from "../edition.ts";
import { categoryLabel } from "../process/taxonomy.ts";
import { buildFtsQuery } from "../search.ts";
import { aiStatus, structured, wrapMaterial } from "./provider.ts";
import { stripUnsupportedSentences } from "./tasks.ts";

// Phase 5 features: grounded Q&A, weekly recap, topic trend analysis.

const Answer = z.object({
  answer: z.string().describe("Answer grounded only in the documents; say plainly what the documents do not establish."),
  citations: z.array(z.number()).describe("article ids that support the answer"),
  support: z.enum(["well_supported", "partially_supported", "insufficient"]),
  independent_confirmation: z.string().describe("Which claims are confirmed by genuinely independent sources versus repeated from one report. Empty if not relevant."),
});

function retrieve(userId: number, question: string, clusterId?: number) {
  const active = activeSourceIds(userId);
  if (!active.length) return [];
  const inActive = `a.source_id IN (${active.map(() => "?").join(",")})`;
  if (clusterId) {
    return all<any>(
      `SELECT a.id, a.headline, a.description, a.content, a.published_at, a.canonical_url, s.name AS source_name, s.kind AS source_kind
       FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.cluster_id = ? AND ${inActive} ORDER BY a.published_at DESC LIMIT 16`,
      clusterId, ...active,
    );
  }
  const { query } = buildFtsQuery(question, true);
  if (!query) return [];
  // Loosen the AND query to OR so natural-language questions retrieve relevant material.
  const loose = query.replace(/ AND /g, " OR ");
  return all<any>(
    `SELECT a.id, a.headline, a.description, a.content, a.published_at, a.canonical_url, s.name AS source_name, s.kind AS source_kind
     FROM articles_fts JOIN articles a ON a.id = articles_fts.rowid JOIN sources s ON s.id = a.source_id
     WHERE articles_fts MATCH ? AND ${inActive} AND a.published_at >= ?
     ORDER BY bm25(articles_fts) + (julianday('now') - julianday(a.published_at)) / 3.0 LIMIT 14`,
    loose, ...active, new Date(Date.now() - 21 * 86_400_000).toISOString(),
  );
}

export async function askQuestion(userId: number, question: string, clusterId?: number) {
  const docs = retrieve(userId, question, clusterId);
  const sources = docs.map((d) => ({ articleId: d.id, headline: d.headline, sourceName: d.source_name, url: d.canonical_url, publishedAt: d.published_at }));
  if (aiStatus() !== "configured") {
    return { status: "not_configured" as const, answer: null, sources, message: "Answering questions requires an Anthropic API key on the server. The most relevant collected articles are listed instead." };
  }
  if (!docs.length) {
    return { status: "ok" as const, answer: "None of the articles collected from your sources address this question.", support: "insufficient", citations: [], sources };
  }
  const material = docs.map((d) => `${d.headline} ${d.description ?? ""} ${(d.content ?? "").slice(0, 2000)}`).join("\n");
  const r = await structured({
    kind: "qa",
    targetId: clusterId ?? null,
    schema: Answer,
    system:
      "You answer readers' questions about the news using only the supplied documents. Cite article ids. If the documents do not answer the question, say so. Do not use outside knowledge for facts about current events. Distinguish independent confirmation from repetition of one report. Plain prose.",
    effort: "medium",
    maxTokens: 6000,
    prompt: `Today is ${new Date().toISOString().slice(0, 10)}.\nQuestion: ${question.slice(0, 600)}\n\n${wrapMaterial(
      docs.map((d) => ({ id: d.id, label: `${d.source_name} (${d.source_kind}), ${d.published_at}`, text: `${d.headline}\n${d.description ?? ""}\n${(d.content ?? "").slice(0, 2000)}` })),
    )}`,
  });
  const valid = new Set(docs.map((d) => d.id));
  const cleaned = stripUnsupportedSentences(r.data.answer, material);
  return {
    status: "ok" as const,
    answer: cleaned.text,
    support: r.data.support,
    independentConfirmation: r.data.independent_confirmation,
    citations: r.data.citations.filter((c) => valid.has(c)),
    removedForMissingSupport: cleaned.removed,
    sources,
  };
}

const Weekly = z.object({
  overview: z.string(),
  themes: z.array(z.object({ theme: z.string(), explanation: z.string(), cluster_ids: z.array(z.number()) })),
  resolved: z.array(z.object({ text: z.string(), cluster_id: z.number() })),
  outstanding: z.array(z.object({ text: z.string(), cluster_id: z.number() })),
});

function isoWeek(d: Date) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86_400_000 + 1) / 7);
  return `${y}-W${String(w).padStart(2, "0")}`;
}

export async function weeklyRecap(userId: number, opts: { refresh?: boolean } = {}) {
  const week = isoWeek(new Date());
  const key = `weekly:${userId}:${week}`;
  const cached = kvGet<any>(key, null);
  if (cached && !opts.refresh && Date.now() - Date.parse(cached.generatedAt) < 6 * 3600_000) return cached;

  const ctx = userContext(userId);
  const stories = storiesFor(ctx, { sinceHours: 7 * 24, limit: 400 });
  const top = stories.slice(0, 15);
  const byCategory = new Map<string, number>();
  for (const s of stories) byCategory.set(s.category, (byCategory.get(s.category) ?? 0) + 1);
  const result: any = {
    week,
    generatedAt: new Date().toISOString(),
    stories: top.map((s) => ({ id: s.id, headline: s.headline, category: s.categoryLabel, importance: s.importance, status: s.status, sourceCount: s.sourceCount, lastUpdateAt: s.lastUpdateAt })),
    categoryCounts: [...byCategory.entries()].map(([k, n]) => ({ category: categoryLabel(k), stories: n })).sort((a, b) => b.stories - a.stories),
    ai: null as any,
    aiStatus: aiStatus(),
  };
  if (aiStatus() === "configured" && top.length) {
    const clusters = all<any>(`SELECT id, headline, summary, status FROM clusters WHERE id IN (${top.map(() => "?").join(",")})`, ...top.map((s) => s.id));
    const docs = top.map((s) => {
      const c = clusters.find((x) => x.id === s.id);
      return { id: s.id, label: `${s.categoryLabel}; status ${c?.status}`, text: `${s.headline}\n${c?.summary ?? s.description ?? ""}` };
    });
    try {
      const r = await structured({
        kind: "weekly",
        targetId: userId,
        schema: Weekly,
        system: "You write a weekly news recap grounded only in the supplied story summaries. Identify major themes, which situations were resolved and which remain open. Cite cluster ids (the document ids). No speculation. Plain prose.",
        effort: "medium",
        maxTokens: 8000,
        prompt: `Week ${week}.\n${wrapMaterial(docs)}`,
      });
      const ids = new Set(top.map((s) => s.id));
      const material = docs.map((d) => d.text).join("\n");
      result.ai = {
        overview: stripUnsupportedSentences(r.data.overview, material).text,
        themes: r.data.themes.map((t) => ({ ...t, cluster_ids: t.cluster_ids.filter((i) => ids.has(i)) })),
        resolved: r.data.resolved.filter((x) => ids.has(x.cluster_id)),
        outstanding: r.data.outstanding.filter((x) => ids.has(x.cluster_id)),
      };
    } catch (e: any) {
      result.aiError = e.message;
    }
  }
  kvSet(key, result);
  return result;
}

/**
 * Topic trends: per day, how much was published (volume) versus how many distinct stories
 * and meaningful developments occurred. A spike in volume without new developments is
 * flagged as a coverage surge rather than a news development.
 */
export function topicTrends(userId: number, topicId: number, days = 30) {
  const active = activeSourceIds(userId);
  if (!active.length) return { days: [], insights: [] };
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const inActive = `a.source_id IN (${active.map(() => "?").join(",")})`;
  const volume = all<{ day: string; articles: number; stories: number }>(
    `SELECT substr(a.published_at, 1, 10) AS day, COUNT(*) AS articles, COUNT(DISTINCT a.cluster_id) AS stories
     FROM articles a WHERE a.published_at >= ? AND ${inActive} AND EXISTS (SELECT 1 FROM json_each(a.topics) WHERE value = ?)
     GROUP BY day ORDER BY day`,
    since, ...active, topicId,
  );
  const developments = all<{ day: string; n: number }>(
    `SELECT substr(e.at, 1, 10) AS day, COUNT(*) AS n FROM cluster_events e
     WHERE e.significant = 1 AND e.at >= ? AND e.cluster_id IN (
       SELECT DISTINCT a.cluster_id FROM articles a WHERE a.published_at >= ? AND ${inActive} AND EXISTS (SELECT 1 FROM json_each(a.topics) WHERE value = ?))
     GROUP BY day`,
    since, since, ...active, topicId,
  );
  const devMap = new Map(developments.map((d) => [d.day, d.n]));
  const out: { day: string; articles: number; stories: number; developments: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    const v = volume.find((x) => x.day === day);
    out.push({ day, articles: v?.articles ?? 0, stories: v?.stories ?? 0, developments: devMap.get(day) ?? 0 });
  }
  const avgArticles = out.reduce((n, d) => n + d.articles, 0) / Math.max(1, out.filter((d) => d.articles).length);
  const insights: string[] = [];
  for (const d of out.slice(-7)) {
    if (d.articles >= Math.max(5, avgArticles * 2) && d.developments <= 1) insights.push(`${d.day}: coverage volume spiked (${d.articles} articles) without a matching number of new developments — likely repeated coverage of the same events.`);
    if (d.developments >= 3) insights.push(`${d.day}: ${d.developments} meaningful developments across ${d.stories} stories.`);
  }
  return { days: out, insights };
}

export { parseJson, get };
