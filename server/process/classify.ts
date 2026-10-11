import {
  ANALYSIS_TITLE, COUNTRIES, LEXICON, LIVE_TITLE, OPINION_TITLE, OPINION_URL, US_CITIES, US_STATES, type CategoryKey,
} from "./taxonomy.ts";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Matcher = { re: RegExp; weight: number; term: string };
const lexiconMatchers: Record<string, Matcher[]> = Object.fromEntries(
  Object.entries(LEXICON).map(([cat, entries]) => [
    cat,
    entries
      .filter(([, w]) => w > 0)
      .map(([term, weight]) => ({ term, weight, re: new RegExp(`(^|[^a-z0-9])${escapeRe(term)}([^a-z0-9]|$)`, "i") })),
  ]),
);

// Short ambiguous terms only count when they appear in their usual capitalization.
const CASE_SENSITIVE = new Map<string, RegExp>([
  ["ai", /\bAI\b/],
  ["eu", /\bEU\b/],
  ["fed", /\bFed\b/],
  ["sec", /\bSEC\b/],
  ["ev", /\bEVs?\b/],
  ["cop", /\bCOP\d*\b/],
  ["app", /\bapps?\b/],
  ["meta", /\bMeta\b/],
  ["apple", /\bApple\b/],
  ["amazon", /\bAmazon\b/],
  ["dow", /\bDow\b/],
  ["bill", /\b[Bb]ill\b(?! (Gates|Clinton|Belichick|Maher))/],
]);

export interface ClassifyInput {
  title: string;
  description: string;
  url: string;
  sourceCategory: string;
  sourceKind: string;
  sourceRegion?: string | null;
}

export interface Classification {
  category: CategoryKey;
  scores: Record<string, number>;
  matched: Record<string, string[]>;
  geo: string[];
  articleType: "news" | "opinion" | "analysis" | "official" | "live";
}

function scoreText(text: string, rawText: string, multiplier: number, scores: Record<string, number>, matched: Record<string, string[]>) {
  for (const [cat, matchers] of Object.entries(lexiconMatchers)) {
    for (const m of matchers) {
      const cs = CASE_SENSITIVE.get(m.term);
      const hit = cs ? cs.test(rawText) : m.re.test(text);
      if (hit) {
        scores[cat] = (scores[cat] ?? 0) + m.weight * multiplier;
        (matched[cat] ??= []).includes(m.term) || matched[cat].push(m.term);
      }
    }
  }
}

export function detectGeo(text: string, sourceRegion?: string | null): string[] {
  const lower = ` ${text.toLowerCase()} `;
  const found = new Set<string>();
  const check = (dict: Record<string, string>) => {
    for (const [name, code] of Object.entries(dict)) {
      if (new RegExp(`[^a-z]${escapeRe(name)}[^a-z]`).test(lower)) found.add(code);
    }
  };
  check(US_STATES);
  check(US_CITIES);
  check(COUNTRIES);
  // "Washington" is ambiguous (state vs. capital); treat as US federal unless "Washington state".
  if (found.has("US-WA") && !/washington state|seattle|spokane|tacoma/.test(lower)) found.delete("US-WA");
  if ([...found].some((c) => c.startsWith("US-"))) found.add("US");
  if (sourceRegion && sourceRegion !== "global" && !found.size) found.add(sourceRegion);
  return [...found];
}

export function detectArticleType(title: string, url: string, sourceKind: string): Classification["articleType"] {
  if (OPINION_TITLE.test(title) || OPINION_URL.test(url)) return "opinion";
  if (LIVE_TITLE.test(title) || /\/live(-news|blog)?\//i.test(url)) return "live";
  if (sourceKind === "official") return "official";
  if (ANALYSIS_TITLE.test(title) || /\/(analysis|explainer)\//i.test(url)) return "analysis";
  return "news";
}

export function classify(input: ClassifyInput): Classification {
  const scores: Record<string, number> = {};
  const matched: Record<string, string[]> = {};
  scoreText(input.title.toLowerCase(), input.title, 2, scores, matched);
  scoreText(input.description.toLowerCase(), input.description, 1, scores, matched);

  const prior = input.sourceCategory;
  if (prior && prior !== "general" && prior !== "local") scores[prior] = (scores[prior] ?? 0) + 3;

  // Politics and U.S. overlap heavily; prefer politics when both are strong.
  if ((scores.politics ?? 0) >= 4 && (scores.us ?? 0) > 0) scores.us = (scores.us ?? 0) * 0.8;

  let best: CategoryKey = "general";
  let bestScore = 0;
  for (const [cat, s] of Object.entries(scores)) {
    if (s > bestScore) {
      best = cat as CategoryKey;
      bestScore = s;
    }
  }
  if (bestScore < 3) best = (prior as CategoryKey) || "general";

  const geo = detectGeo(`${input.title} ${input.description}`, input.sourceRegion);
  // A U.S.-only story from a general source is "us" rather than "world" when nothing foreign is mentioned.
  if (best === "world" && geo.length && geo.every((g) => g === "US" || g.startsWith("US-"))) best = "us";

  return { category: best, scores, matched, geo, articleType: detectArticleType(input.title, input.url, input.sourceKind) };
}
