import { z } from "zod";
import { getPrefs } from "../auth.ts";
import { aiStatus, structured, wrapMaterial } from "../ai/provider.ts";
import { stripUnsupportedSentences, unsupportedNumbers } from "../ai/tasks.ts";
import { all, get, json, nowIso, parseJson, run } from "../db.ts";
import { lastRefresh, sourceHealthFor, storiesFor, userContext, type StoryCard } from "../edition.ts";
import { emit } from "../events.ts";
import { log } from "../log.ts";
import { extractSynthesis, type Quoted } from "../process/extract.ts";
import { categoryLabel } from "../process/taxonomy.ts";
import { sha256, wordCount } from "../process/text.ts";
import { currentEdition, isValidTimeZone, overnightStart, type EditionInfo } from "./time.ts";

// Quick Reads: the daily intelligence briefing. Built from the reader's active edition.
// Story selection, change tracking, overnight developments and the watch list are
// deterministic; prose (big picture, per-story write-ups) comes from the AI provider when
// configured, and otherwise the briefing uses attributed publisher descriptions and says so.

export interface BriefingStory {
  clusterId: number;
  headline: string;
  category: string;
  categoryLabel: string;
  importance: number;
  reasons: string[];
  isBreaking: boolean;
  status: string;
  firstPublishedAt: string;
  lastUpdateAt: string;
  publisherDescription: { text: string; sourceName: string } | null;
  sources: { articleId: number; sourceName: string; sourceKind: string; url: string; publishedAt: string; headline: string }[];
  ai: null | {
    twoMin: string;
    whatHappened: string;
    whyItMatters: string;
    keyFacts: { text: string; articleIds: number[] }[];
    whatsNext: string;
    background: string;
    disagreements: string[];
  };
  /** Without AI: sentences quoted verbatim from the coverage, each citing its article. */
  extract?: null | {
    inBrief: Quoted[];
    whatHappened: Quoted[];
    keyFacts: Quoted[];
    more: Quoted[];
    quotes: Quoted[];
  };
}

export interface BriefingContent {
  editionLabel: string;
  window: { start: string; end: string };
  bigPicture: {
    status: "generated" | "extracted" | "not_configured" | "failed";
    text: string;
    themes: string[];
    changeNote: string;
    error?: string;
    /** "extracted": the lead sentence of each top story, quoted from its coverage. */
    items?: { clusterId: number; headline: string; text: string; articleId: number; sourceName: string }[];
  };
  stories: BriefingStory[];
  modes: { two: number[]; five: number[]; ten: number[] };
  readingMinutes: { two: number; five: number; ten: number };
  overnight: { from: string; to: string; label: string; items: { clusterId: number; headline: string; text: string; at: string; kind: string; isNew: boolean }[] };
  changes: {
    previousBriefingId: number | null;
    previousGeneratedAt: string | null;
    newStories: { clusterId: number; headline: string }[];
    significantUpdates: { clusterId: number; headline: string; text: string; at: string }[];
    corrections: { clusterId: number; headline: string; text: string; at: string; kind: string }[];
    lessRelevant: { clusterId: number; headline: string; reason: string }[];
  };
  watch: { id: number; title: string; startsAt: string | null; dateText: string | null; certainty: string; why: string | null; sourceName: string | null; sourceUrl: string | null; clusterId: number | null }[];
  coverageNotes: { kind: "source_failing" | "source_stale" | "category_empty" | "no_sources" | "ai"; text: string }[];
}

const BriefingAi = z.object({
  big_picture: z.string().describe("3-5 sentences: the most important developments, connecting themes, significant changes, key uncertainty. Every sentence must carry information."),
  themes: z.array(z.string()).describe("2-4 short phrases naming the day's connecting themes."),
  change_note: z.string().describe("One or two sentences on what materially changed since the previous briefing, or empty string."),
  stories: z.array(
    z.object({
      cluster_id: z.number(),
      two_min: z.string().describe("One or two sentences: the essential development."),
      what_happened: z.string().describe("Two or three sentences on the verified development."),
      why_it_matters: z.string().describe("One or two sentences on implications; empty string if unsupported."),
      key_facts: z.array(z.object({ text: z.string(), article_ids: z.array(z.number()) })),
      whats_next: z.string().describe("Upcoming decisions/events/open questions only if the material supports it; else empty string."),
      background: z.string().describe("Two to four sentences of context drawn from the material, for the ten-minute read."),
      disagreements: z.array(z.string()).describe("Relevant disagreements between credible sources in the material, attributed; may be empty."),
    }),
  ),
});

const BRIEFING_SYSTEM = `You write the daily briefing for a serious newspaper app. Readers want to be meaningfully informed in two, five or ten minutes.
Ground every statement in the supplied documents and story syntheses. Prioritise factual substance over dramatic wording. Attribute claims. Do not invent quotations, numbers, motives or future outcomes; leave a field empty rather than speculate. Avoid filler such as "Today was a busy day in the news." Plain prose, no markdown.`;

function editionLabel(e: EditionInfo) {
  return e.edition === "morning" ? "Morning Edition" : "Evening Edition";
}

function selectStories(ranked: StoryCard[]) {
  const supported = ranked.filter((s) => (s.sourceCount >= 2 || s.hasOfficial || s.baseImportance >= 40) && s.lead.articleType !== "opinion");
  const pool = supported.length >= 3 ? supported : ranked;
  const ten: StoryCard[] = [];
  // Ten-minute mode: top stories plus breadth across business, technology and world when available.
  for (const s of pool) {
    if (ten.length >= 12) break;
    ten.push(s);
  }
  for (const cat of ["business", "technology", "world", "science", "health"]) {
    if (ten.length >= 15) break;
    if (!ten.some((s) => s.category === cat)) {
      const extra = pool.find((s) => s.category === cat && !ten.includes(s));
      if (extra) ten.push(extra);
    }
  }
  const five = ten.slice(0, Math.min(8, Math.max(5, Math.min(ten.length, 8))));
  const two = ten.slice(0, Math.min(4, ten.length));
  return { ten, five, two };
}

function readingMinutes(words: number) {
  return Math.max(1, Math.round(words / 230));
}

export async function generateBriefing(userId: number, opts: { force?: boolean; reason?: string; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const user = get<{ timezone: string }>("SELECT timezone FROM users WHERE id = ?", userId);
  if (!user) throw new Error("User not found");
  const prefs = getPrefs(userId);
  const tz = isValidTimeZone(user.timezone) ? user.timezone : "UTC";
  const edition = currentEdition(now, tz, prefs.briefing.morningCutoff, prefs.briefing.eveningCutoff);

  // Finalize any earlier live editions.
  run("UPDATE briefings SET status = 'final' WHERE user_id = ? AND status = 'live' AND NOT (edition_date = ? AND edition = ?)", userId, edition.editionDate, edition.edition);

  const ctx = userContext(userId);
  const windowStart = new Date(now.getTime() - 24 * 3600_000);
  const ranked = storiesFor(ctx, { sinceHours: 30 }).filter((s) => Date.parse(s.lastArticleAt) >= windowStart.getTime() || Date.parse(s.lastUpdateAt) >= windowStart.getTime());
  const { ten, five, two } = selectStories(ranked);

  const signature = sha256(ten.map((s) => `${s.id}:${s.lastUpdateAt}`).join("|")).slice(0, 24);
  const current = get<any>(
    "SELECT * FROM briefings WHERE user_id = ? AND edition_date = ? AND edition = ? ORDER BY revision DESC LIMIT 1",
    userId, edition.editionDate, edition.edition,
  );
  // A manual refresh with no change in stories or their updates does not create an empty revision.
  if (current && opts.force && opts.reason === "manual" && current.signature === signature) return { briefingId: current.id, regenerated: false, reason: "unchanged" };
  if (current && !opts.force) {
    const ageMin = (now.getTime() - Date.parse(current.generated_at)) / 60_000;
    const newBreaking = ten.some((s) => s.isBreaking && !parseJson<number[]>(current.story_ids, []).includes(s.id));
    if (current.signature === signature) return { briefingId: current.id, regenerated: false, reason: "unchanged" };
    if (ageMin < 20 && !newBreaking) return { briefingId: current.id, regenerated: false, reason: "throttled" };
    // Minor reshuffles do not warrant a new revision: require a new story in the top five or a significant update.
    const prevIds = parseJson<number[]>(current.story_ids, []);
    const topChanged = five.some((s) => !prevIds.includes(s.id));
    const updated = five.some((s) => Date.parse(s.lastUpdateAt) > Date.parse(current.generated_at));
    if (!topChanged && !updated && !newBreaking) return { briefingId: current.id, regenerated: false, reason: "no_material_change" };
  }

  // ---- Deterministic sections ----------------------------------------------------------
  const storyIds = ten.map((s) => s.id);
  const articleRows = storyIds.length
    ? all<any>(
        `SELECT a.id, a.cluster_id, a.headline, a.description, a.content, a.content_basis, a.page_text, a.article_type, a.canonical_url, a.published_at, a.source_id,
           s.name AS source_name, s.kind AS source_kind
         FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.cluster_id IN (${storyIds.map(() => "?").join(",")}) ORDER BY a.published_at DESC`,
        ...storyIds,
      ).filter((a) => ctx.active.has(a.source_id))
    : [];
  const clusterRows = new Map(
    (storyIds.length ? all<any>(`SELECT * FROM clusters WHERE id IN (${storyIds.map(() => "?").join(",")})`, ...storyIds) : []).map((c) => [c.id, c]),
  );

  const stories: BriefingStory[] = ten.map((s) => {
    const arts = articleRows.filter((a) => a.cluster_id === s.id);
    return {
      clusterId: s.id,
      headline: s.headline,
      category: s.category,
      categoryLabel: categoryLabel(s.category),
      importance: s.importance,
      reasons: [...s.reasons.filter((r) => r.points > 0).map((r) => r.label).slice(0, 3), ...s.personalReasons],
      isBreaking: s.isBreaking,
      status: s.status,
      firstPublishedAt: s.firstPublishedAt,
      lastUpdateAt: s.lastUpdateAt,
      publisherDescription: s.description ? { text: s.description, sourceName: s.lead.sourceName } : null,
      sources: arts.slice(0, 8).map((a) => ({ articleId: a.id, sourceName: a.source_name, sourceKind: a.source_kind, url: a.canonical_url, publishedAt: a.published_at, headline: a.headline })),
      ai: null,
    };
  });

  const previous = get<any>(
    `SELECT * FROM briefings WHERE user_id = ? AND NOT (edition_date = ? AND edition = ?) ORDER BY edition_date DESC, generated_at DESC LIMIT 1`,
    userId, edition.editionDate, edition.edition,
  );
  const sinceIso = previous?.generated_at ?? windowStart.toISOString();
  const prevIds = parseJson<number[]>(previous?.story_ids, []);
  const changes: BriefingContent["changes"] = {
    previousBriefingId: previous?.id ?? null,
    previousGeneratedAt: previous?.generated_at ?? null,
    newStories: previous ? stories.filter((s) => !prevIds.includes(s.clusterId)).slice(0, 8).map((s) => ({ clusterId: s.clusterId, headline: s.headline })) : [],
    significantUpdates: [],
    corrections: [],
    lessRelevant: [],
  };
  if (previous) {
    const evs = all<any>(
      `SELECT e.cluster_id, e.kind, e.text, e.at, e.article_id, c.headline FROM cluster_events e JOIN clusters c ON c.id = e.cluster_id
       LEFT JOIN articles a ON a.id = e.article_id
       WHERE e.significant = 1 AND e.observed_at > ? AND e.kind != 'first_report' ORDER BY e.at DESC LIMIT 200`,
      sinceIso,
    ).filter((e) => !e.article_id || articleRows.some((a) => a.id === e.article_id) || true);
    for (const e of evs) {
      if (e.kind === "correction" || e.kind === "retraction") {
        changes.corrections.push({ clusterId: e.cluster_id, headline: e.headline, text: e.text, at: e.at, kind: e.kind });
      } else if (prevIds.includes(e.cluster_id) && storyIds.includes(e.cluster_id) && !changes.significantUpdates.some((x) => x.clusterId === e.cluster_id)) {
        changes.significantUpdates.push({ clusterId: e.cluster_id, headline: e.headline, text: e.text, at: e.at });
      }
    }
    for (const id of prevIds) {
      if (storyIds.includes(id)) continue;
      const c = get<any>("SELECT id, headline, status, importance, last_update_at FROM clusters WHERE id = ?", id);
      if (!c) continue;
      const reason =
        c.status === "resolved" ? "Resolved" : c.status === "quiet" ? "No new developments" : "Outranked by more significant stories";
      changes.lessRelevant.push({ clusterId: c.id, headline: c.headline, reason });
    }
    changes.lessRelevant = changes.lessRelevant.slice(0, 8);
  }

  const ovFrom = overnightStart(edition, tz, prefs.briefing.overnightFrom);
  const overnightEvents = all<any>(
    `SELECT e.cluster_id, e.kind, e.text, e.at, c.headline, c.first_seen_at, c.importance FROM cluster_events e JOIN clusters c ON c.id = e.cluster_id
     WHERE e.significant = 1 AND e.at >= ? AND e.at <= ? ORDER BY c.importance DESC, e.at DESC LIMIT 300`,
    ovFrom.toISOString(), now.toISOString(),
  );
  const visibleClusterIds = new Set(storiesFor(ctx, { sinceHours: 36, limit: 400 }).map((s) => s.id));
  const overnightItems: BriefingContent["overnight"]["items"] = [];
  for (const e of overnightEvents) {
    if (!visibleClusterIds.has(e.cluster_id) || overnightItems.some((x) => x.clusterId === e.cluster_id)) continue;
    if (e.importance < 30) continue;
    // A story that began before the window but changed during it is shown as an update, not as new.
    const isNew = Date.parse(e.first_seen_at) >= ovFrom.getTime() && e.kind === "first_report";
    overnightItems.push({ clusterId: e.cluster_id, headline: e.headline, text: e.text, at: e.at, kind: e.kind, isNew });
    if (overnightItems.length >= 8) break;
  }

  const watch = all<any>(
    `SELECT * FROM upcoming_events WHERE (created_by IS NULL OR created_by = ?) AND
       ((starts_at IS NOT NULL AND starts_at >= ?) OR (starts_at IS NULL AND created_at >= ?))
     ORDER BY CASE WHEN starts_at IS NULL THEN 1 ELSE 0 END, starts_at ASC LIMIT 12`,
    userId, now.toISOString(), new Date(now.getTime() - 3 * 86_400_000).toISOString(),
  ).map((w) => ({ id: w.id, title: w.title, startsAt: w.starts_at, dateText: w.date_text, certainty: w.certainty, why: w.why, sourceName: w.source_name, sourceUrl: w.source_url, clusterId: w.cluster_id }));

  const coverageNotes: BriefingContent["coverageNotes"] = [];
  const health = sourceHealthFor(userId);
  if (!health.total) coverageNotes.push({ kind: "no_sources", text: "No sources are enabled, so there is nothing to brief. Enable sources on the Sources page." });
  for (const f of health.failing.slice(0, 6)) coverageNotes.push({ kind: "source_failing", text: `${f.name} is not updating: ${f.error ?? "retrieval failing"}.` });
  for (const st of health.stale.slice(0, 4)) coverageNotes.push({ kind: "source_stale", text: `${st.name} has not updated successfully since ${st.lastSuccessAt}.` });
  for (const sec of prefs.homepage.sections.filter((s) => s.enabled)) {
    if (!ranked.some((s) => s.category === sec.key)) coverageNotes.push({ kind: "category_empty", text: `No ${categoryLabel(sec.key)} stories in the last 24 hours from your sources.` });
  }

  // ---- AI prose ------------------------------------------------------------------------
  const prevHeadlines = prevIds.length
    ? all<{ headline: string }>(`SELECT headline FROM clusters WHERE id IN (${prevIds.map(() => "?").join(",")})`, ...prevIds).map((r) => r.headline)
    : [];
  const prose = await applyAiProse(userId, stories, articleRows, clusterRows, `${editionLabel(edition)}, ${edition.editionDate} (${tz})`, prevHeadlines);
  const bigPicture = prose.bigPicture;
  const aiModel = prose.aiModel;
  coverageNotes.push(...prose.notes);

  const storyWords = (s: BriefingStory, mode: "two" | "five" | "ten") => {
    const a = s.ai;
    const base = wordCount(s.headline);
    const words = (qs: Quoted[] | undefined) => (qs ?? []).reduce((n, q) => n + wordCount(q.text), 0);
    if (!a && s.extract) {
      const x = s.extract;
      if (mode === "two") return base + words(x.inBrief);
      return base + words(x.whatHappened) + (mode === "ten" ? words(x.keyFacts) + words(x.more) + words(x.quotes) : 0);
    }
    if (!a) return base + wordCount(s.publisherDescription?.text ?? "") * (mode === "two" ? 0.5 : 1);
    if (mode === "two") return base + wordCount(a.twoMin);
    const five = wordCount(a.whatHappened) + wordCount(a.whyItMatters) + a.keyFacts.reduce((n, f) => n + wordCount(f.text), 0);
    return base + five + (mode === "ten" ? wordCount(a.background) + wordCount(a.whatsNext) + a.disagreements.reduce((n, d) => n + wordCount(d), 0) : 0);
  };
  const bpWords = wordCount(bigPicture.text);
  const content: BriefingContent = {
    editionLabel: editionLabel(edition),
    window: { start: windowStart.toISOString(), end: now.toISOString() },
    bigPicture,
    stories,
    modes: { two: two.map((s) => s.id), five: five.map((s) => s.id), ten: ten.map((s) => s.id) },
    readingMinutes: {
      two: readingMinutes(bpWords * 0.5 + stories.filter((s) => two.some((t) => t.id === s.clusterId)).reduce((n, s) => n + storyWords(s, "two"), 0)),
      five: readingMinutes(bpWords + stories.filter((s) => five.some((t) => t.id === s.clusterId)).reduce((n, s) => n + storyWords(s, "five"), 0) + 120),
      ten: readingMinutes(bpWords + stories.reduce((n, s) => n + storyWords(s, "ten"), 0) + 300),
    },
    overnight: {
      from: ovFrom.toISOString(),
      to: now.toISOString(),
      label: edition.edition === "morning" ? "Overnight" : "Since this morning",
      items: overnightItems,
    },
    changes,
    watch,
    coverageNotes,
  };

  const refresh = lastRefresh();
  const revision = (current?.revision ?? 0) + 1;
  const r = run(
    `INSERT INTO briefings (user_id, edition_date, edition, timezone, window_start, window_end, generated_at, data_refreshed_at, status,
       revision, supersedes_id, revision_reason, ai_status, ai_model, content, story_ids, source_refs, signature)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    userId, edition.editionDate, edition.edition, tz, windowStart.toISOString(), now.toISOString(), nowIso(), refresh.lastSuccessAt,
    now >= edition.endsAt ? "final" : "live", revision, current?.id ?? null,
    opts.reason ?? (current ? "live_update" : "initial"),
    bigPicture.status === "generated" ? "generated" : bigPicture.status === "failed" ? "failed" : "not_configured",
    aiModel, json(content), json(storyIds),
    json(stories.flatMap((s) => s.sources.map((x) => ({ articleId: x.articleId, url: x.url, sourceName: x.sourceName })))), signature,
  );
  const id = Number(r.lastInsertRowid);
  log("info", "briefing", `Generated ${editionLabel(edition)} rev ${revision} for user ${userId}`, { stories: stories.length, ai: bigPicture.status });
  emit({ type: "briefing", briefingId: id, editionDate: edition.editionDate });
  return { briefingId: id, regenerated: true, reason: opts.reason ?? "generated" };
}

/**
 * Correct an edition: creates a new revision (the original row is preserved). The current
 * edition is fully rebuilt; a past edition keeps its stories and window and only has its
 * prose re-written from the current state of those stories' articles.
 */
export async function regenerateEdition(briefingId: number) {
  const b = get<any>("SELECT * FROM briefings WHERE id = ?", briefingId);
  if (!b) throw new Error("Briefing not found");
  const latest = get<any>("SELECT * FROM briefings WHERE user_id = ? ORDER BY generated_at DESC LIMIT 1", b.user_id);
  if (latest && latest.edition_date === b.edition_date && latest.edition === b.edition && b.status === "live") {
    return generateBriefing(b.user_id, { force: true, reason: "manual" });
  }
  const content = parseJson<BriefingContent>(b.content, null as any);
  const ids = content.stories.map((s) => s.clusterId);
  const ctx = userContext(b.user_id);
  const articleRows = ids.length
    ? all<any>(
        `SELECT a.id, a.cluster_id, a.headline, a.description, a.content, a.content_basis, a.page_text, a.article_type, a.canonical_url, a.published_at, a.source_id,
           s.name AS source_name, s.kind AS source_kind
         FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.cluster_id IN (${ids.map(() => "?").join(",")}) AND a.published_at <= ? ORDER BY a.published_at DESC`,
        ...ids, b.window_end,
      ).filter((a) => ctx.active.has(a.source_id))
    : [];
  const clusterRows = new Map((ids.length ? all<any>(`SELECT * FROM clusters WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids) : []).map((c) => [c.id, c]));
  for (const s of content.stories) {
    s.ai = null;
    s.extract = null;
  }
  const prose = await applyAiProse(b.user_id, content.stories, articleRows, clusterRows, `${content.editionLabel}, ${b.edition_date} (correction)`, []);
  content.bigPicture = prose.bigPicture;
  content.coverageNotes = [...content.coverageNotes.filter((n) => n.kind !== "ai"), ...prose.notes];
  const rev = get<{ r: number }>("SELECT MAX(revision) AS r FROM briefings WHERE user_id = ? AND edition_date = ? AND edition = ?", b.user_id, b.edition_date, b.edition)!.r;
  const r = run(
    `INSERT INTO briefings (user_id, edition_date, edition, timezone, window_start, window_end, generated_at, data_refreshed_at, status,
       revision, supersedes_id, revision_reason, ai_status, ai_model, content, story_ids, source_refs, signature)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'final', ?, ?, 'correction', ?, ?, ?, ?, ?, ?)`,
    b.user_id, b.edition_date, b.edition, b.timezone, b.window_start, b.window_end, nowIso(), b.data_refreshed_at, rev + 1, b.id,
    prose.bigPicture.status === "generated" || prose.bigPicture.status === "failed" ? prose.bigPicture.status : "not_configured", prose.aiModel, json(content), b.story_ids, b.source_refs, b.signature,
  );
  return { briefingId: Number(r.lastInsertRowid), regenerated: true, reason: "correction", preservedOriginalId: b.id };
}

export function briefingSchedulerTick() {
  const users = all<{ id: number }>("SELECT id FROM users");
  return Promise.all(
    users.map((u) =>
      generateBriefing(u.id).catch((e) => {
        log("error", "briefing", "Briefing generation failed", { userId: u.id, error: e?.message });
        return null;
      }),
    ),
  );
}

/**
 * Without an AI key: fill each story with sentences quoted from its own coverage (full article
 * text where it was read), and build the overview from each top story's lead sentence.
 * Mutates story.extract.
 */
function applyExtracts(stories: BriefingStory[], articleRows: any[]): BriefingContent["bigPicture"] {
  const items: NonNullable<BriefingContent["bigPicture"]["items"]> = [];
  const themeCount = new Map<string, { name: string; n: number }>();
  for (const s of stories) {
    const arts = articleRows.filter((a) => a.cluster_id === s.clusterId);
    const ex = extractSynthesis(arts, { maxArticles: 16 });
    s.extract = ex
      ? // Sized so the five- and ten-minute reads stay close to their names.
        { inBrief: ex.summary.slice(0, 1), whatHappened: ex.summary.slice(0, 2), keyFacts: ex.keyFacts.slice(0, 1), more: ex.story.slice(0, 1), quotes: ex.quotes.slice(0, 1) }
      : null;
    // Make sure every quoted article is in the story's source list so its citation resolves.
    const cited = new Set(Object.values(s.extract ?? {}).flatMap((qs) => qs.flatMap((q) => q.article_ids)));
    for (const a of arts) {
      if (cited.has(a.id) && !s.sources.some((x) => x.articleId === a.id)) {
        s.sources.push({ articleId: a.id, sourceName: a.source_name, sourceKind: a.source_kind, url: a.canonical_url, publishedAt: a.published_at, headline: a.headline });
      }
    }
    if (ex?.summary[0] && items.length < 5) {
      const a = arts.find((x) => x.id === ex.summary[0].article_ids[0]);
      items.push({ clusterId: s.clusterId, headline: s.headline, text: ex.summary[0].text, articleId: a?.id ?? 0, sourceName: a?.source_name ?? "" });
    }
    for (const e of ex?.shared.slice(0, 4) ?? []) {
      const key = e.name.toLowerCase();
      const t = themeCount.get(key) ?? { name: e.name, n: 0 };
      t.n++;
      themeCount.set(key, t);
    }
  }
  // Names that recur across several of the day's stories.
  const themes = [...themeCount.values()].filter((t) => t.n >= 2).sort((a, b) => b.n - a.n).slice(0, 4).map((t) => t.name);
  return items.length
    ? { status: "extracted", text: items.map((i) => i.text).join(" "), themes, changeNote: "", items }
    : { status: "not_configured", text: "", themes: [], changeNote: "" };
}

/** Write briefing prose with the AI provider, validating citations and figures. Mutates story.ai. */
async function applyAiProse(
  userId: number,
  stories: BriefingStory[],
  articleRows: any[],
  clusterRows: Map<number, any>,
  editionText: string,
  prevHeadlines: string[],
): Promise<{ bigPicture: BriefingContent["bigPicture"]; aiModel: string | null; notes: BriefingContent["coverageNotes"] }> {
  const notes: BriefingContent["coverageNotes"] = [];
  if (aiStatus() !== "configured") {
    notes.push({ kind: "ai", text: "AI summaries are not configured, so each story is summarised with sentences quoted from its own coverage." });
    return { bigPicture: applyExtracts(stories, articleRows), aiModel: null, notes };
  }
  if (!stories.length) return { bigPicture: { status: "generated", text: "", themes: [], changeNote: "" }, aiModel: null, notes };
  const docs: { id: string | number; label: string; text: string }[] = [];
  const materialByStory = new Map<number, string>();
  for (const s of stories) {
    const c = clusterRows.get(s.clusterId);
    const arts = articleRows.filter((a) => a.cluster_id === s.clusterId).slice(0, 5);
    const text = [
      `STORY cluster_id=${s.clusterId} category=${s.category} last_update=${s.lastUpdateAt}`,
      c?.summary ? `Story synthesis (from earlier processing): ${c.summary}` : "",
      ...arts.map((a) => `[article_id=${a.id}] ${a.source_name} (${a.source_kind}), ${a.published_at}: ${a.headline}. ${a.description ?? ""} ${(a.content ?? "").slice(0, 1200)}`),
    ].filter(Boolean).join("\n");
    materialByStory.set(s.clusterId, text);
    docs.push({ id: `story-${s.clusterId}`, label: s.headline, text });
  }
  try {
    const r = await structured({
      kind: "briefing",
      targetId: userId,
      schema: BriefingAi,
      system: BRIEFING_SYSTEM,
      effort: "medium",
      maxTokens: 20000,
      prompt:
        `Edition: ${editionText}. Write the briefing for the ${stories.length} stories below, in the given order. ` +
        `Return one entry per story using its cluster_id. Cite article_id values in key_facts.\n` +
        (prevHeadlines.length ? `Stories in the previous briefing: ${prevHeadlines.map((h) => `“${h}”`).join("; ")}\n` : "No previous briefing exists.\n") +
        `\n${wrapMaterial(docs)}`,
    });
    const allMaterial = [...materialByStory.values()].join("\n");
    for (const st of r.data.stories) {
      const story = stories.find((s) => s.clusterId === st.cluster_id);
      if (!story) continue;
      const mat = materialByStory.get(st.cluster_id) ?? "";
      const ids = new Set(articleRows.filter((a) => a.cluster_id === st.cluster_id).map((a) => a.id));
      const clean = (t: string) => stripUnsupportedSentences(t, mat).text;
      story.ai = {
        twoMin: clean(st.two_min),
        whatHappened: clean(st.what_happened),
        whyItMatters: clean(st.why_it_matters),
        keyFacts: st.key_facts
          .map((f) => ({ text: f.text, articleIds: f.article_ids.filter((id) => ids.has(id)) }))
          .filter((f) => f.articleIds.length && !unsupportedNumbers(f.text, mat).length),
        whatsNext: clean(st.whats_next),
        background: clean(st.background),
        disagreements: st.disagreements.map(clean).filter(Boolean),
      };
    }
    return {
      bigPicture: {
        status: "generated",
        text: stripUnsupportedSentences(r.data.big_picture, allMaterial).text,
        themes: r.data.themes.slice(0, 4),
        changeNote: stripUnsupportedSentences(r.data.change_note, allMaterial).text,
      },
      aiModel: r.model,
      notes,
    };
  } catch (e: any) {
    notes.push({ kind: "ai", text: `AI briefing generation failed (${e.message}); showing publisher descriptions instead.` });
    return { bigPicture: { status: "failed", text: "", themes: [], changeNote: "", error: e.message }, aiModel: null, notes };
  }
}
