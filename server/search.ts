import { all, parseJson } from "./db.ts";
import { activeSourceIds } from "./edition.ts";
import { categoryLabel } from "./process/taxonomy.ts";

// Full-text search over articles (SQLite FTS5, porter stemming) restricted to the reader's
// active sources. Concept expansion: when the query names a known topic or one of its
// keywords, the topic's other keywords are added as alternatives, so "AI" also finds
// "machine learning" and "language model" coverage.

export interface SearchParams {
  q: string;
  sourceIds?: number[];
  category?: string;
  topicId?: number;
  from?: string;
  to?: string;
  geo?: string;
  type?: string;
  sort?: "relevance" | "latest" | "importance";
  page?: number;
  pageSize?: number;
  expand?: boolean;
}

function ftsTerm(t: string) {
  return `"${t.replace(/"/g, '""')}"`;
}

export function buildFtsQuery(q: string, expand = true): { query: string; expandedWith: string[] } {
  const phrases: string[] = [];
  const rest = q.replace(/"([^"]+)"/g, (_, p) => {
    phrases.push(p.trim());
    return " ";
  });
  const words = rest
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}'-]/gu, ""))
    .filter((w) => w.length > 0 && !/^(and|or|not|the|a|an|of|in|on)$/i.test(w));
  const parts = [...phrases.map(ftsTerm), ...words.map((w) => `${ftsTerm(w)}*`)];
  if (!parts.length) return { query: "", expandedWith: [] };
  let query = parts.join(" AND ");
  const expandedWith: string[] = [];
  if (expand) {
    const topics = all<{ name: string; keywords: string }>("SELECT name, keywords FROM topics WHERE owner_id IS NULL");
    const ql = q.trim().toLowerCase();
    for (const t of topics) {
      const kws = parseJson<string[]>(t.keywords, []);
      if (t.name.toLowerCase() === ql || kws.some((k) => k.toLowerCase() === ql)) {
        const alts = kws.filter((k) => k.toLowerCase() !== ql).slice(0, 8);
        expandedWith.push(...alts);
        query = `(${query}) OR ${alts.map(ftsTerm).join(" OR ")}`;
        break;
      }
    }
  }
  return { query, expandedWith };
}

export function search(userId: number, p: SearchParams) {
  const page = Math.max(1, p.page ?? 1);
  const pageSize = Math.min(50, Math.max(5, p.pageSize ?? 20));
  const { query, expandedWith } = buildFtsQuery(p.q, p.expand !== false);
  const active = activeSourceIds(userId);
  const sourceFilter = p.sourceIds?.length ? p.sourceIds.filter((s) => active.includes(s)) : active;
  if (!sourceFilter.length) return { total: 0, page, pageSize, results: [], expandedWith };

  const where: string[] = [`a.source_id IN (${sourceFilter.map(() => "?").join(",")})`];
  const params: (string | number)[] = [...sourceFilter];
  if (query) {
    where.push("articles_fts MATCH ?");
    params.unshift(query);
  }
  if (p.category) {
    where.push("a.category = ?");
    params.push(p.category);
  }
  if (p.topicId) {
    where.push("EXISTS (SELECT 1 FROM json_each(a.topics) WHERE value = ?)");
    params.push(p.topicId);
  }
  if (p.from) {
    where.push("a.published_at >= ?");
    params.push(new Date(p.from).toISOString());
  }
  if (p.to) {
    where.push("a.published_at <= ?");
    params.push(new Date(new Date(p.to).getTime() + 86_399_999).toISOString());
  }
  if (p.geo) {
    where.push("EXISTS (SELECT 1 FROM json_each(a.geo) WHERE value = ? OR value LIKE ?)");
    params.push(p.geo, `${p.geo}-%`);
  }
  if (p.type) {
    where.push("a.article_type = ?");
    params.push(p.type);
  }
  const from = query ? "articles_fts JOIN articles a ON a.id = articles_fts.rowid" : "articles a";
  // Relevance blends text match with recency and story importance.
  const order =
    p.sort === "latest"
      ? "a.published_at DESC"
      : p.sort === "importance"
        ? "COALESCE(c.importance, 0) DESC, a.published_at DESC"
        : query
          ? "(bm25(articles_fts) - COALESCE(c.importance, 0) / 25.0 + (julianday('now') - julianday(a.published_at)) / 7.0) ASC"
          : "a.published_at DESC";
  // The FTS MATCH parameter must come first because it appears first in the WHERE clause.
  const sql = `FROM ${from} LEFT JOIN clusters c ON c.id = a.cluster_id JOIN sources s ON s.id = a.source_id WHERE ${
    query ? "articles_fts MATCH ? AND " : ""
  }${where.filter((w) => !w.startsWith("articles_fts")).join(" AND ")}`;
  const total = all<{ n: number }>(`SELECT COUNT(*) AS n ${sql}`, ...params)[0]?.n ?? 0;
  const rows = all<any>(
    `SELECT a.id, a.headline, a.description, a.canonical_url, a.published_at, a.category, a.article_type, a.cluster_id, a.link_status,
            s.name AS source_name, s.id AS source_id, c.importance, c.article_count AS cluster_size
            ${query ? ", snippet(articles_fts, 1, '[[', ']]', '…', 18) AS snippet" : ""}
     ${sql} ORDER BY ${order} LIMIT ? OFFSET ?`,
    ...params, pageSize, (page - 1) * pageSize,
  );
  return {
    total,
    page,
    pageSize,
    expandedWith,
    results: rows.map((r) => ({
      articleId: r.id,
      headline: r.headline,
      description: r.description,
      snippet: r.snippet ?? null,
      url: r.canonical_url,
      publishedAt: r.published_at,
      category: r.category,
      categoryLabel: categoryLabel(r.category),
      articleType: r.article_type,
      clusterId: r.cluster_id,
      clusterSize: r.cluster_size,
      importance: r.importance,
      sourceName: r.source_name,
      sourceId: r.source_id,
      linkStatus: r.link_status,
    })),
  };
}
