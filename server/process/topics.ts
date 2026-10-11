import { all, json, nowIso, parseJson, run } from "../db.ts";
import { BUILTIN_TOPICS } from "../sources/catalog.ts";

// Topic matching: a topic is a set of keywords/entities (any or all must match) optionally
// limited to categories. Built-in topics are shared; custom topics belong to one user.

interface TopicRow {
  id: number;
  slug: string;
  keywords: string;
  categories: string;
  match_mode: string;
}

type Compiled = { id: number; res: RegExp[]; categories: string[]; mode: string };
let compiled: Compiled[] | null = null;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function keywordRegex(k: string) {
  // Short all-caps keywords (AI, CDC, FDA) must match case-sensitively to avoid noise.
  const caseSensitive = k.length <= 4 && k === k.toUpperCase();
  return new RegExp(`(^|[^A-Za-z0-9])${escapeRe(k)}(s)?([^A-Za-z0-9]|$)`, caseSensitive ? "" : "i");
}

function load(): Compiled[] {
  if (!compiled) {
    compiled = all<TopicRow>("SELECT id, slug, keywords, categories, match_mode FROM topics").map((t) => ({
      id: t.id,
      res: parseJson<string[]>(t.keywords, []).filter(Boolean).map(keywordRegex),
      categories: parseJson<string[]>(t.categories, []),
      mode: t.match_mode,
    }));
  }
  return compiled;
}

export function invalidateTopics() {
  compiled = null;
}

export function matchTopics(text: string, category: string): number[] {
  const out: number[] = [];
  for (const t of load()) {
    if (t.categories.length && !t.categories.includes(category)) continue;
    if (!t.res.length) {
      if (t.categories.length) out.push(t.id);
      continue;
    }
    const hit = t.mode === "all" ? t.res.every((r) => r.test(text)) : t.res.some((r) => r.test(text));
    if (hit) out.push(t.id);
  }
  return out;
}

export function seedTopics() {
  for (const t of BUILTIN_TOPICS) {
    run(
      `INSERT INTO topics (slug, name, description, keywords, categories, owner_id, created_at)
       SELECT ?, ?, ?, ?, ?, NULL, ? WHERE NOT EXISTS (SELECT 1 FROM topics WHERE slug = ? AND owner_id IS NULL)`,
      t.slug, t.name, t.description, json(t.keywords), json(t.categories ?? []), nowIso(), t.slug,
    );
  }
  invalidateTopics();
}

/** Re-match recent articles after a topic is created or edited. */
export function backfillTopic(topicId: number, days = 30) {
  invalidateTopics();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = all<{ id: number; headline: string; description: string | null; category: string; topics: string }>(
    "SELECT id, headline, description, category, topics FROM articles WHERE published_at >= ?",
    since,
  );
  let n = 0;
  for (const r of rows) {
    const ids = matchTopics(`${r.headline} ${r.description ?? ""}`, r.category);
    const prev = parseJson<number[]>(r.topics, []);
    const has = ids.includes(topicId);
    const had = prev.includes(topicId);
    if (has !== had) {
      const next = has ? [...prev, topicId] : prev.filter((x) => x !== topicId);
      run("UPDATE articles SET topics = ? WHERE id = ?", json(next), r.id);
      n++;
    }
  }
  return n;
}
