import { z } from "zod";
import { config } from "../config.ts";
import { all, get, json, nowIso, parseJson, run } from "../db.ts";
import { emit } from "../events.ts";
import { log } from "../log.ts";
import { sha256 } from "../process/text.ts";
import { aiStatus, structured, takeArticleBudget, wrapMaterial } from "./provider.ts";

// AI tasks: article summaries, story (cluster) synthesis with coverage comparison, and
// extraction of upcoming events. Outputs are checked against the source material:
// citations must point to supplied documents and figures must appear in the material.

const ArticleSummary = z.object({
  summary: z.string().describe("2-3 sentence factual summary of what the article reports."),
  key_actors: z.array(z.string()).describe("People, organisations or places central to the report."),
  claim_status: z.enum(["established", "alleged", "mixed", "opinion"]).describe("Whether the main claims are established facts, allegations, a mix, or opinion."),
});

const ARTICLE_SYSTEM = `You summarise news articles for a newspaper app.
Rules: preserve the main factual claims, key actors, dates and figures; keep qualifications; distinguish allegations from established findings; attribute statements to who made them; never invent quotations, numbers, motives or outcomes. If the material is only a short excerpt, summarise only what it says. Plain prose, no markdown.`;

/** Find numbers in generated text that do not occur anywhere in the material. */
export function unsupportedNumbers(text: string, material: string): string[] {
  const norm = (s: string) => s.replace(/,(?=\d{3})/g, "");
  const mat = norm(material);
  const nums = norm(text).match(/\b\d+(?:\.\d+)?%?/g) ?? [];
  return [...new Set(nums)].filter((n) => {
    const bare = n.replace("%", "");
    if (/^(19|20)\d{2}$/.test(bare) && mat.includes(bare)) return false;
    return !new RegExp(`(^|[^\\d.])${bare.replace(".", "\\.")}([^\\d]|$)`).test(mat);
  });
}

/** Drop sentences containing figures that the sources never mention. */
export function stripUnsupportedSentences(text: string, material: string): { text: string; removed: string[] } {
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [text];
  const kept: string[] = [];
  const removed: string[] = [];
  for (const s of sentences) {
    if (unsupportedNumbers(s, material).length) removed.push(s.trim());
    else kept.push(s);
  }
  return { text: kept.join("").trim(), removed };
}

export async function summarizeArticle(articleId: number, opts: { force?: boolean } = {}) {
  if (aiStatus() !== "configured") return { status: "not_configured" as const };
  const a = get<any>(
    "SELECT a.*, s.name AS source_name FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ?",
    articleId,
  );
  if (!a) return { status: "not_found" as const };
  if (a.summary && !opts.force) return { status: "exists" as const };
  if (!takeArticleBudget()) return { status: "budget_exhausted" as const };
  const material = [a.headline, a.description ?? "", a.page_text ?? a.content ?? ""].join("\n\n").trim();
  const basis = a.page_text ? "full_page_text" : a.content_basis === "full_feed_text" ? "full_feed_text" : "excerpt";
  try {
    const r = await structured({
      kind: "article_summary",
      targetId: articleId,
      schema: ArticleSummary,
      system: ARTICLE_SYSTEM,
      model: config.aiArticleModel,
      effort: "low",
      maxTokens: 4000,
      prompt:
        `Summarise this ${a.source_name} article. ${basis === "excerpt" ? "Only the publisher's feed excerpt is available, not the full article; do not imply otherwise." : ""}\n\n` +
        wrapMaterial([{ id: a.id, label: `${a.source_name}: ${a.headline}`, text: material }]),
    });
    const checked = stripUnsupportedSentences(r.data.summary, material);
    run(
      "UPDATE articles SET summary = ?, summary_at = ?, summary_model = ?, summary_basis = ?, review_status = ?, processing_status = 'summarized' WHERE id = ?",
      checked.text || null, nowIso(), r.model, basis, r.data.claim_status === "alleged" ? "contains_allegations" : checked.removed.length ? "figures_removed" : "auto_checked", articleId,
    );
    return { status: "ok" as const };
  } catch (e: any) {
    run("UPDATE articles SET processing_error = ? WHERE id = ?", `Summary failed: ${e.message}`, articleId);
    return { status: "error" as const, error: e.message };
  }
}

const Cited = z.object({ text: z.string(), article_ids: z.array(z.number()) });
const ClusterSynthesis = z.object({
  summary: z.string().describe("3-5 sentence synthesis of the verified development, attributing claims."),
  why_it_matters: z.string().describe("1-2 sentences on practical implications or who is affected. Empty string if the sources do not support it."),
  key_facts: z.array(Cited).describe("Most important figures, dates, decisions; each cites supporting document ids."),
  consistent_facts: z.array(Cited).describe("Facts reported consistently by more than one document."),
  single_source_details: z.array(Cited).describe("Details only one document reports."),
  unverified_official_claims: z.array(Cited).describe("Claims by officials or parties not independently verified in the material."),
  disputed: z.array(z.object({ point: z.string(), positions: z.array(Cited) })).describe("Contradictory accounts or differing interpretations."),
  emphasis_differences: z.array(Cited).describe("Notable differences in framing or emphasis between publications."),
  contributions: z.array(z.object({ article_id: z.number(), contribution: z.string() })).describe("What new information each document adds."),
  unresolved: z.array(z.string()).describe("Open questions the sources raise or leave unanswered."),
  upcoming: z
    .array(
      z.object({
        title: z.string(),
        date_iso: z.string().nullable().describe("ISO 8601 date or datetime if the material states it, else null."),
        date_text: z.string().describe("The timing as the material states it, e.g. 'next Tuesday', 'by end of month'."),
        certainty: z.enum(["confirmed", "scheduled", "estimated"]),
        why: z.string(),
        article_id: z.number(),
      }),
    )
    .describe("Scheduled or expected future events explicitly mentioned in the material. Never speculate."),
  status: z.enum(["developing", "ongoing", "resolved"]),
});

const CLUSTER_SYSTEM = `You are the copy desk of a careful newspaper. You receive several reports (documents) about what may be the same news event, each with an id, publisher and timestamps.
Write a neutral synthesis grounded only in the documents. Cite document ids for facts. Use cautious language: several documents repeating one original report are not independent confirmation, and official claims are claims until independently verified. Distinguish allegations from findings. Never invent quotations, numbers, motives or future outcomes. When only feed excerpts are available, do not imply you read full articles. Plain prose, no markdown.`;

export function clusterBasisHash(clusterId: number) {
  const rows = all<{ id: number; last_meaningful_update_at: string }>(
    "SELECT id, last_meaningful_update_at FROM articles WHERE cluster_id = ? ORDER BY id",
    clusterId,
  );
  return sha256(rows.map((r) => `${r.id}:${r.last_meaningful_update_at}`).join("|")).slice(0, 24);
}

export async function summarizeCluster(clusterId: number, opts: { force?: boolean } = {}) {
  if (aiStatus() !== "configured") return { status: "not_configured" as const };
  const c = get<any>("SELECT * FROM clusters WHERE id = ?", clusterId);
  if (!c) return { status: "not_found" as const };
  const basis = clusterBasisHash(clusterId);
  if (!opts.force && c.summary && c.summary_basis_hash === basis) {
    run("UPDATE clusters SET needs_resummary = 0 WHERE id = ?", clusterId);
    return { status: "unchanged" as const };
  }
  const arts = all<any>(
    `SELECT a.id, a.headline, a.description, a.content, a.content_basis, a.page_text, a.published_at, a.article_type, s.name AS source_name, s.kind AS source_kind
     FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.cluster_id = ? ORDER BY a.published_at DESC LIMIT 14`,
    clusterId,
  );
  const docs = arts.map((a) => ({
    id: a.id,
    label: `${a.source_name} (${a.source_kind}, ${a.article_type}) published ${a.published_at}; ${a.page_text ? "full article text from the publisher's page" : a.content_basis === "full_feed_text" ? "full text from feed" : "feed excerpt only"}`,
    text: [a.headline, a.description ?? "", (a.page_text ?? a.content ?? "").slice(0, 8000)].join("\n").trim(),
  }));
  const material = docs.map((d) => d.text).join("\n");
  const validIds = new Set(arts.map((a) => a.id));
  try {
    const r = await structured({
      kind: "cluster_summary",
      targetId: clusterId,
      schema: ClusterSynthesis,
      system: CLUSTER_SYSTEM,
      effort: "medium",
      maxTokens: 12000,
      prompt: `Today is ${new Date().toISOString().slice(0, 10)}. Synthesize these reports.\n\n${wrapMaterial(docs)}`,
    });
    const d = r.data;
    // Citation integrity: keep only items that cite supplied documents.
    const cite = (xs: { text: string; article_ids: number[] }[]) =>
      xs
        .map((x) => ({ text: x.text, article_ids: x.article_ids.filter((id) => validIds.has(id)) }))
        .filter((x) => x.article_ids.length && !unsupportedNumbers(x.text, material).length);
    const summary = stripUnsupportedSentences(d.summary, material);
    const why = stripUnsupportedSentences(d.why_it_matters, material);
    const coverage = {
      consistent: cite(d.consistent_facts),
      singleSource: cite(d.single_source_details),
      unverifiedOfficial: cite(d.unverified_official_claims),
      emphasis: cite(d.emphasis_differences),
      contributions: d.contributions.filter((x) => validIds.has(x.article_id)),
      removedForMissingSupport: [...summary.removed, ...why.removed],
      basedOn: arts.length,
      basis: arts.some((a) => a.page_text || a.content_basis === "full_feed_text") ? "mixed" : "excerpts",
    };
    const history = parseJson<any[]>(c.summary_history, []);
    if (c.summary) history.push({ at: c.summary_at, summary: c.summary, model: c.summary_model });
    run(
      `UPDATE clusters SET summary = ?, why_it_matters = ?, key_facts = ?, unresolved = ?, disputed = ?, coverage = ?, summary_at = ?,
         summary_model = ?, summary_basis_hash = ?, summary_history = ?, needs_resummary = 0, summary_error = NULL,
         status = CASE WHEN ? = 'resolved' THEN 'resolved' WHEN status = 'resolved' THEN 'active' ELSE status END WHERE id = ?`,
      summary.text || null, why.text || null, json(cite(d.key_facts)), json(d.unresolved),
      json(d.disputed.map((x) => ({ point: x.point, positions: cite(x.positions) })).filter((x) => x.positions.length)),
      json(coverage), nowIso(), r.model, basis, json(history.slice(-20)), d.status, clusterId,
    );
    for (const u of d.upcoming) {
      if (!validIds.has(u.article_id)) continue;
      const art = arts.find((a) => a.id === u.article_id);
      const startsAt = u.date_iso && !Number.isNaN(Date.parse(u.date_iso)) ? new Date(u.date_iso).toISOString() : null;
      run(
        `INSERT INTO upcoming_events (title, starts_at, date_text, certainty, why, category, cluster_id, article_id, source_name, source_url, origin, created_at, dedupe_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT canonical_url FROM articles WHERE id = ?), 'ai_extracted', ?, ?)
         ON CONFLICT(dedupe_key) DO UPDATE SET starts_at = excluded.starts_at, date_text = excluded.date_text, certainty = excluded.certainty, why = excluded.why`,
        u.title, startsAt, u.date_text, u.certainty, u.why, c.category, clusterId, u.article_id, art?.source_name ?? null, u.article_id,
        nowIso(), sha256(`${clusterId}|${u.title.toLowerCase()}`).slice(0, 24),
      );
    }
    emit({ type: "cluster", clusterId, reason: "summary" });
    return { status: "ok" as const };
  } catch (e: any) {
    run("UPDATE clusters SET summary_error = ?, needs_resummary = 0 WHERE id = ?", e.message, clusterId);
    return { status: "error" as const, error: e.message };
  }
}

// ---- Background worker ---------------------------------------------------------------

let busy = false;
export async function aiWorkerTick(maxClusters = 6) {
  if (busy || aiStatus() !== "configured") return { processed: 0 };
  busy = true;
  let processed = 0;
  try {
    // Only stories that matter get a synthesis; quiet or minor stories keep publisher text.
    const due = all<{ id: number }>(
      `SELECT id FROM clusters WHERE needs_resummary = 1 AND (importance >= 40 OR source_count >= 3)
       AND last_article_at >= ? ORDER BY importance DESC LIMIT ?`,
      new Date(Date.now() - 48 * 3600_000).toISOString(), maxClusters,
    );
    for (const { id } of due) {
      const r = await summarizeCluster(id);
      if (r.status === "ok") processed++;
    }
    // Lead articles of the most important stories get article-level summaries.
    const leads = all<{ id: number }>(
      `SELECT a.id FROM clusters c JOIN articles a ON a.id = c.lead_article_id
       WHERE a.summary IS NULL AND a.processing_error IS NULL AND c.importance >= 45 AND c.last_article_at >= ?
       ORDER BY c.importance DESC LIMIT 5`,
      new Date(Date.now() - 24 * 3600_000).toISOString(),
    );
    for (const { id } of leads) await summarizeArticle(id);
  } catch (e: any) {
    log("error", "ai", "AI worker tick failed", { error: e?.message });
  } finally {
    busy = false;
  }
  return { processed };
}
