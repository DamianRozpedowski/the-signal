import { extractEntities, jaccard, terms } from "./text.ts";

// Story synthesis without an AI model: picks sentences verbatim from the publishers' own
// text (the full article where it could be read, otherwise the feed excerpt) and compares
// what each outlet reports. Nothing is paraphrased or invented; every item points back to
// the article it was taken from. One "already said" memory is shared by every section, so a
// fact or quotation that appears once is not repeated further down the page.

export type ExtractArticle = {
  id: number;
  headline: string;
  description: string | null;
  content: string | null;
  content_basis?: string | null;
  page_text?: string | null;
  source_id: number;
  source_name: string;
  article_type?: string | null;
  published_at: string;
};

export type Quoted = { text: string; article_ids: number[] };

export type ExtractedSynthesis = {
  summary: Quoted[];
  story: Quoted[];
  keyFacts: Quoted[];
  quotes: Quoted[];
  shared: { name: string; article_ids: number[]; publishers: number }[];
  singleSource: Quoted[];
  headlines: { article_id: number; source_name: string; headline: string }[];
  basedOn: number;
  fullTextCount: number;
  publishers: number;
  basis: "excerpts" | "mixed" | "full_text";
};

const BOILERPLATE = [
  /^(continue reading|read more|more on |click here|sign up|subscribe|listen|watch|follow |related:|recommended)/i,
  /\b(has|have) the (story|details)\.?$/i,
  /\bmore on [A-Z]{2,}\.?$/,
  /^(photo|image|video|getty|reuters|ap photo)\b/i,
  /(cookie|newsletter|terms of (use|service)|privacy policy|contributed to this report|this story has been (updated|corrected))/i,
  /\b(reports|has the forecast|has the latest|for more|joins us|explains)\.?$/i,
];
const ENTITY_SKIP = new Set(["category", "president", "prime minister", "minister", "government", "police", "officials", "associated press", "ap", "reuters"]);
const OPEN_Q = "\"“‘(";
const CLOSE_Q = "\"”’)";
const SPLIT = new RegExp(`(?<=[.!?][${CLOSE_Q}]?)\\s+(?=[${OPEN_Q}]?[A-Z0-9])`);
const ENDS = new RegExp(`[.!?][${CLOSE_Q}]?$`);

type Sentence = { text: string; terms: string[]; quoted: string[]; shingles: string[]; art: ExtractArticle; pos: number };

/** Runs of six consecutive words; two sentences sharing a long run are making the same claim. */
function shingles(s: string): string[] {
  const w = s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i + 6 <= w.length; i++) out.push(w.slice(i, i + 6).join(" "));
  return out;
}

/** The best text available for an article: full page text, full feed text, or the excerpt. */
export function articleBody(a: ExtractArticle): string {
  if (a.page_text) return a.page_text;
  if (a.content_basis === "full_feed_text" && a.content) return `${a.description ?? ""}\n${a.content}`;
  return a.description ?? "";
}

// Abbreviations that end in a period without ending the sentence ("the U.S. Gulf Coast").
const ABBREV = /(?:^|\s)(?:[A-Z]\.){1,3}$|\b(?:Mr|Mrs|Ms|Dr|Gov|Sen|Rep|Gen|Col|Lt|Sgt|St|Jr|Sr|Inc|Corp|Co|No|vs|Ft|Mt|Jan|Feb|Mar|Apr|Aug|Sept?|Oct|Nov|Dec|Ala|Ariz|Ark|Calif|Colo|Conn|Del|Fla|Ga|Ill|Ind|Kan|Ky|La|Md|Mass|Mich|Minn|Miss|Mo|Mont|Neb|Nev|Okla|Ore|Pa|Tenn|Tex|Va|Vt|Wash|Wis|Wyo)\.$/;

function splitSentences(line: string): string[] {
  const out: string[] = [];
  // Paragraphs glued together by the page markup: "the Appalachians.Isaias came ashore".
  const unglued = line
    .replace(/([a-z]{2}[.!?])(["“]?[A-Z][a-z]?)/g, "$1 $2")
    .replace(/([.!?]["”])(["“]?[A-Z])/g, "$1 $2");
  for (const piece of unglued.split(SPLIT)) {
    if (out.length && ABBREV.test(out[out.length - 1])) out[out.length - 1] += ` ${piece}`;
    else out.push(piece);
  }
  return out;
}

/** Drop a closing quotation mark that has no opening one (left over from sentence splitting). */
function balanceQuotes(s: string) {
  const straight = (s.match(/"/g) ?? []).length;
  if (straight % 2 === 1 && /"$|"[.!?]?$/.test(s) && !s.startsWith('"')) s = s.replace(/"([.!?]?)$/, "$1");
  const open = (s.match(/“/g) ?? []).length;
  const close = (s.match(/”/g) ?? []).length;
  if (close > open && /”[.!?]?$/.test(s)) s = s.replace(/”([.!?]?)$/, "$1");
  return s;
}

/** Quoted phrases of four or more words, normalised, so the same quotation is recognised in any outlet. */
function quotedPhrases(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/["“]([^"”]{12,})["”]|(?:^|\s)‘([^’]{12,})’(?=[\s,.;:!?]|$)/g)) {
    const inner = m[1] ?? m[2];
    const words = inner.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
    if (words.length >= 4) out.push(words.join(" "));
  }
  return out;
}

function sentencesOf(a: ExtractArticle): Sentence[] {
  const out: Sentence[] = [];
  const seen = new Set<string>();
  for (const line of articleBody(a).slice(0, 12_000).split(/\n+/)) {
    for (const raw of splitSentences(line)) {
      const text = balanceQuotes(
        raw
          .replace(/[​-‍⁠﻿]/g, "")
          .replace(/\s+/g, " ")
          .replace(/\s+([,.;:!?])/g, "$1")
          // Datelines: "CAIRO (AP) — ", "BERLIN, Oct 10 (Reuters) - ", "GULF BREEZE, Fla. -- ".
          .replace(/^[A-Z][A-Z .'-]{2,30}(?:,\s*[A-Z][A-Za-z.]{1,10}(?:\s\d{1,2})?)?\s*(?:\((?:AP|Reuters|AFP|UPI)\)\s*)?(?:--|[—–-])\s*/, "")
          .trim(),
      );
      if (text.length < 40 || text.length > 360) continue;
      if (!ENDS.test(text) || /…$|\.\.\.$/.test(text)) continue;
      if (/^[a-z]/.test(text) || /[a-z]{3}[A-Z][a-z]/.test(text)) continue; // fragment, or a heading glued to a sentence
      if (BOILERPLATE.some((re) => re.test(text))) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ text, terms: [...new Set(terms(text))], quoted: quotedPhrases(text), shingles: shingles(text), art: a, pos: out.length });
    }
  }
  return out;
}

// Dates and times are not "figures": "(October 9, 2026)", "Oct. 10", "9:41 p.m.".
const DATES = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?|\b\d{1,2}:\d{2}\b|\b(?:19|20)\d{2}\b/gi;
const figures = (s: string) => (s.replace(DATES, " ").replace(/,(?=\d{3})/g, "").match(/\b\d+(?:\.\d+)?\b/g) ?? []);
const isQuote = (s: string) => /["“][^"”]{25,}["”]/.test(s) && /\b(said|says|told|added|according to|wrote|posted|stated)\b/i.test(s);

/** Share of the smaller set that the two sets have in common (catches rewordings of one fact). */
function containment(a: string[], b: string[]) {
  if (!a.length || !b.length) return 0;
  const B = new Set(b);
  let n = 0;
  for (const x of a) if (B.has(x)) n++;
  return n / Math.min(a.length, new Set(b).size);
}

/** Build an extractive synthesis for one story from its articles (any order). */
export function extractSynthesis(input: ExtractArticle[], opts: { maxArticles?: number } = {}): ExtractedSynthesis | null {
  const arts = input
    .slice()
    .sort((a, b) => b.published_at.localeCompare(a.published_at))
    .slice(0, opts.maxArticles ?? 30);
  if (!arts.length) return null;

  // How many distinct publishers use each term in their headline and lede: the backbone of
  // "what the story is about".
  const termPubs = new Map<string, Set<number>>();
  for (const a of arts) {
    for (const t of new Set(terms(`${a.headline} ${a.description ?? ""}`))) {
      if (!termPubs.has(t)) termPubs.set(t, new Set());
      termPubs.get(t)!.add(a.source_id);
    }
  }
  const publishers = new Set(arts.map((a) => a.source_id)).size;

  const sentences = arts.flatMap(sentencesOf);
  const score = (s: Sentence) => {
    if (!s.terms.length) return 0;
    let shared = 0;
    for (const t of s.terms) shared += Math.max(0, (termPubs.get(t)?.size ?? 1) - 1) + (termPubs.has(t) ? 0.5 : 0);
    let v = shared / Math.sqrt(s.terms.length);
    v *= 1 / (1 + s.pos * 0.04); // ledes carry the news; later paragraphs carry detail
    if (s.art.article_type && !["news", "live"].includes(s.art.article_type)) v *= 0.6;
    return v;
  };
  const ranked = sentences.map((s) => ({ s, v: score(s) })).sort((a, b) => b.v - a.v);

  // ---- The shared "already said" memory --------------------------------------------------
  const used: Sentence[] = [];
  const covered = new Set<string>();
  const quotedSeen = new Set<string>();
  const shingleSeen = new Set<string>();
  const perArticle = new Map<number, number>();
  /** Share of a sentence's terms the reader has not seen yet. */
  const novelty = (s: Sentence) => (s.terms.length ? s.terms.filter((t) => !covered.has(t)).length / s.terms.length : 0);
  const repeats = (s: Sentence, minNovelty: number) =>
    used.includes(s) ||
    novelty(s) < minNovelty ||
    used.some((u) => containment(s.terms, u.terms) >= 0.6 || jaccard(s.terms, u.terms) >= 0.35) ||
    s.quoted.some((q) => [...quotedSeen].some((p) => p.includes(q) || q.includes(p))) ||
    s.shingles.filter((x) => shingleSeen.has(x)).length >= 2;
  const take = (s: Sentence) => {
    used.push(s);
    for (const t of s.terms) covered.add(t);
    for (const q of s.quoted) quotedSeen.add(q);
    for (const x of s.shingles) shingleSeen.add(x);
    perArticle.set(s.art.id, (perArticle.get(s.art.id) ?? 0) + 1);
  };

  // In brief: the single most representative sentence, then the best ones that add something.
  // Different outlets are preferred, so the brief is not one publisher's framing.
  const summary: Quoted[] = [];
  const briefSources = new Set<number>();
  for (const pass of [0, 1]) {
    // A second sentence from an outlet already quoted only if the brief would otherwise be one line.
    for (const { s } of ranked) {
      if (summary.length >= (pass === 0 ? 3 : 2)) break;
      if (pass === 0 && briefSources.has(s.art.source_id)) continue;
      if (repeats(s, summary.length ? 0.6 : 0)) continue;
      take(s);
      briefSources.add(s.art.source_id);
      summary.push({ text: s.text, article_ids: [s.art.id] });
    }
  }

  // Figures: sentences carrying numbers that have not been stated yet; other outlets that give
  // the same numbers are cited alongside.
  const keyFacts: Quoted[] = [];
  const allText = new Map(arts.map((a) => [a.id, `${a.headline} ${articleBody(a)}`]));
  const statedFigures = new Set(used.flatMap((u) => figures(u.text)));
  for (const { s } of ranked) {
    if (keyFacts.length >= 4) break;
    const nums = figures(s.text);
    // Skip sentences whose numbers have all been given already ("300,000 tons" three ways).
    if (!nums.length || nums.every((n) => statedFigures.has(n)) || repeats(s, 0.4)) continue;
    for (const n of nums) statedFigures.add(n);
    const also = arts
      .filter((a) => a.source_id !== s.art.source_id)
      .filter((a) => {
        const f = new Set(figures(allText.get(a.id)!));
        return nums.every((n) => f.has(n));
      })
      .map((a) => a.id);
    take(s);
    keyFacts.push({ text: s.text, article_ids: [s.art.id, ...new Set(also)] });
  }

  // What people said: attributed quotations not already quoted above.
  const quotes: Quoted[] = [];
  for (const { s } of ranked) {
    if (quotes.length >= 4) break;
    if (!isQuote(s.text) || repeats(s, 0.3)) continue;
    take(s);
    quotes.push({ text: s.text, article_ids: [s.art.id] });
  }

  // The fuller story: relevant sentences that each add something new, at most a few from any
  // one article, read in the order the reporting appeared.
  const storyPicks: Sentence[] = [];
  const target = Math.min(14, 5 + Math.round(sentences.length / 15));
  for (const { s, v } of ranked) {
    if (storyPicks.length >= target || v <= 0) break;
    if ((perArticle.get(s.art.id) ?? 0) >= 3 || repeats(s, 0.45)) continue;
    take(s);
    storyPicks.push(s);
  }
  storyPicks.sort((a, b) => a.art.published_at.localeCompare(b.art.published_at) || a.art.id - b.art.id || a.pos - b.pos);
  const story = storyPicks.map((s) => ({ text: s.text, article_ids: [s.art.id] }));

  // Names and places, and which publishers mention them.
  const sourceNames = new Set(arts.flatMap((a) => [a.source_name.toLowerCase(), ...a.source_name.toLowerCase().split(/\s+[—–-]\s+|\s+\(/)]));
  const entityArts = new Map<string, { name: string; arts: Set<number>; pubs: Set<number> }>();
  for (const a of arts) {
    const text = `${a.headline}. ${articleBody(a).slice(0, 4000)}`;
    for (const key of extractEntities(text)) {
      if (key.length < 3 || key.includes(". ") || sourceNames.has(key) || ENTITY_SKIP.has(key)) continue;
      const display = text.match(new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"))?.[0] ?? key;
      if (!entityArts.has(key)) entityArts.set(key, { name: display, arts: new Set(), pubs: new Set() });
      const e = entityArts.get(key)!;
      e.arts.add(a.id);
      e.pubs.add(a.source_id);
    }
  }
  const shared = [...entityArts.values()]
    .filter((e) => e.pubs.size >= 2)
    .sort((a, b) => b.pubs.size - a.pubs.size || b.arts.size - a.arts.size)
    .slice(0, 10)
    .map((e) => ({ name: e.name, article_ids: [...e.arts], publishers: e.pubs.size }));

  // Details only one publisher reports: sentences naming something no other outlet mentions.
  const singleSource: Quoted[] = [];
  if (publishers >= 2) {
    // A name counts only if none of its words belong to a name other outlets also use.
    const sharedWords = new Set([...entityArts.entries()].filter(([, e]) => e.pubs.size >= 2).flatMap(([k]) => k.split(/\s+/)));
    const lonely = [...entityArts.entries()]
      .filter(([k, e]) => e.pubs.size === 1 && k.length >= 4 && !k.split(/\s+/).some((w) => sharedWords.has(w)))
      .map(([k]) => k);
    for (const { s } of ranked) {
      if (singleSource.length >= 4) break;
      const lower = s.text.toLowerCase();
      if (!lonely.some((k) => lower.includes(k)) || repeats(s, 0.5)) continue;
      take(s);
      singleSource.push({ text: s.text, article_ids: [s.art.id] });
    }
  }

  // Each publisher's most recent headline, to compare framing.
  const headlines: ExtractedSynthesis["headlines"] = [];
  const seenPub = new Set<number>();
  for (const a of arts) {
    if (seenPub.has(a.source_id)) continue;
    seenPub.add(a.source_id);
    headlines.push({ article_id: a.id, source_name: a.source_name, headline: a.headline });
  }

  if (!summary.length && !keyFacts.length && !shared.length) return null;
  const fullTextCount = arts.filter((a) => a.page_text || (a.content_basis === "full_feed_text" && a.content)).length;
  return {
    summary,
    story,
    keyFacts,
    quotes,
    shared,
    singleSource,
    headlines: headlines.length >= 2 ? headlines : [],
    basedOn: arts.length,
    fullTextCount,
    publishers,
    basis: fullTextCount === 0 ? "excerpts" : fullTextCount === arts.length ? "full_text" : "mixed",
  };
}
