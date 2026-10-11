// Static edition: the API, answered in the browser.
//
// When the app is built with `vite build --mode static` (GitHub Pages), there is no server. A scheduled
// job publishes the edition as JSON files under <base>/data (see server/static/build.ts),
// and this module answers the same /api URLs the pages already use: published data comes
// from those files, and the reader's own state (preferences, saved items, history, source
// and topic choices, saved searches) lives in this browser's localStorage.

export const STATIC = import.meta.env.MODE === "static";
const BASE = import.meta.env.BASE_URL ?? "/";

export const LOCAL_ONLY = "This needs the full version of The Signal running on your computer. The online edition is read-only and updates every hour.";

export class StaticError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// ---- Published files ------------------------------------------------------------------

let version = "";
const cache = new Map<string, Promise<any>>();

export async function edition(): Promise<{ generatedAt: string; version: string; timezone: string; fullText: boolean }> {
  const res = await fetch(`${BASE}data/meta.json`, { cache: "no-cache" });
  if (!res.ok) throw new StaticError(503, "The online edition has not been published yet. It appears after the first scheduled update.");
  const meta = await res.json();
  if (meta.version !== version) {
    version = meta.version;
    cache.clear();
  }
  return meta;
}

function file<T = any>(rel: string): Promise<T> {
  let p = cache.get(rel);
  if (!p) {
    p = (async () => {
      if (!version) await edition();
      const res = await fetch(`${BASE}data/${rel}.json?v=${version}`);
      if (res.status === 404) throw new StaticError(404, "This page is not part of the current online edition. Older stories drop out after a few days.");
      if (!res.ok) throw new StaticError(res.status, `Could not load the edition (${res.status}).`);
      return res.json();
    })();
    p.catch(() => cache.delete(rel));
    cache.set(rel, p);
  }
  // Callers adjust what they get; never let them change the cached copy.
  return p.then((d) => structuredClone(d));
}

// ---- Reader state (this browser only) ----------------------------------------------------

interface LocalState {
  prefs: any;
  sources: Record<number, { enabled: boolean; priority?: number }>;
  topics: Record<number, "follow" | "mute">;
  saved: { list: string; targetType: string; targetId: number; savedAt: string; readAt: string | null; note: string | null; target: any }[];
  history: { target_type: string; target_id: number; at: string; headline: string }[];
  visits: Record<number, string>;
  searches: { id: number; name: string; query: any; alert: number; created_at: string }[];
}

const KEY = "the-signal:reader";
function load(): LocalState {
  let s: Partial<LocalState> = {};
  try {
    s = JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {};
  } catch {
    /* private mode or corrupt: start fresh */
  }
  return { prefs: {}, sources: {}, topics: {}, saved: [], history: [], visits: {}, searches: [], ...s };
}
let state = load();
function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* storage full or blocked: keep working for this visit */
  }
}

function deepMerge(base: any, patch: any): any {
  if (Array.isArray(base) || typeof base !== "object" || base === null) return patch === undefined ? base : patch;
  const out: any = { ...base };
  for (const k of Object.keys(patch ?? {})) {
    const bv = base[k];
    const pv = patch[k];
    out[k] = bv && typeof bv === "object" && !Array.isArray(bv) && pv && typeof pv === "object" && !Array.isArray(pv) ? deepMerge(bv, pv) : pv;
  }
  return out;
}

async function prefs() {
  const { defaults } = await file("prefs");
  const merged = deepMerge(defaults, state.prefs);
  for (const s of defaults.homepage.sections) if (!merged.homepage.sections.some((x: any) => x.key === s.key)) merged.homepage.sections.push({ ...s, enabled: false });
  for (const n of defaults.nav.order) if (!merged.nav.order.includes(n)) merged.nav.order.push(n);
  return merged;
}

/** Which sources this reader has on: their own choice, else the directory default. */
async function sourceFilter() {
  const { sources } = await file("sources");
  const on = new Set<number>();
  for (const s of sources) if (state.sources[s.id]?.enabled ?? s.defaultEnabled) on.add(s.id);
  return on;
}

async function personalizer() {
  const on = await sourceFilter();
  const muted = new Set(Object.entries(state.topics).filter(([, v]) => v === "mute").map(([k]) => Number(k)));
  const followed = new Set(Object.entries(state.topics).filter(([, v]) => v === "follow").map(([k]) => Number(k)));
  const visible = (c: any) => c && (c.sources ?? []).some((s: any) => on.has(s.id)) && !(c.topics ?? []).some((t: number) => muted.has(t));
  const cards = (list: any[] | undefined) => (list ?? []).filter(visible);
  return { on, muted, followed, visible, cards };
}

const nowIso = () => new Date().toISOString();

function recordHistory(type: string, id: number, headline: string) {
  state.history = [{ target_type: type, target_id: id, at: nowIso(), headline }, ...state.history.filter((h) => !(h.target_type === type && h.target_id === id))].slice(0, 100);
  persist();
}

function isSaved(type: string, id: number, list: string) {
  return state.saved.some((s) => s.targetType === type && s.targetId === id && s.list === list);
}

// ---- Search ----------------------------------------------------------------------------

function tokens(q: string) {
  const phrases: string[] = [];
  const rest = q.replace(/"([^"]+)"/g, (_, p) => (phrases.push(p.trim().toLowerCase()), " "));
  const words = rest
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}'-]/gu, ""))
    .filter((w) => w && !/^(and|or|not|the|a|an|of|in|on)$/.test(w));
  return { phrases, words };
}

function snippet(text: string, terms: string[]) {
  const lower = text.toLowerCase();
  const at = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, at - 60);
  let s = (start ? "…" : "") + text.slice(start, start + 220) + (start + 220 < text.length ? "…" : "");
  for (const t of terms) s = s.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\p{L}\\p{N}]*)`, "giu"), "[[$1]]");
  return s;
}

async function search(p: URLSearchParams) {
  const [{ articles }, topicsFile, { on }, cats] = await Promise.all([file("search-index"), file("topics"), personalizer(), file("categories")]);
  const label = (k: string) => cats.categories.find((c: any) => c.key === k)?.label ?? k;
  const q = p.get("q") ?? "";
  let { phrases, words } = tokens(q);
  const expandedWith: string[] = [];
  const ql = q.trim().toLowerCase();
  const concept = ql ? topicsFile.topics.find((t: any) => !t.custom && (t.name.toLowerCase() === ql || t.keywords.some((k: string) => k.toLowerCase() === ql))) : null;
  const alts: string[] = concept ? concept.keywords.filter((k: string) => k.toLowerCase() !== ql).slice(0, 8) : [];
  if (alts.length && p.get("expand") !== "0") expandedWith.push(...alts);
  const sources = p.get("sources")?.split(",").map(Number).filter(Number.isFinite);
  const from = p.get("from") ? new Date(p.get("from")!).toISOString() : null;
  const to = p.get("to") ? new Date(new Date(p.get("to")!).getTime() + 86_399_999).toISOString() : null;
  const topic = Number(p.get("topic")) || null;
  const scored: { r: any[]; score: number }[] = [];
  for (const r of articles as any[][]) {
    const [, headline, description, , publishedAt, category, type, , sourceId, , importance, , topics, geo] = r;
    if (!on.has(sourceId) || (sources?.length && !sources.includes(sourceId))) continue;
    if (p.get("category") && category !== p.get("category")) continue;
    if (p.get("type") && type !== p.get("type")) continue;
    if (topic && !topics.includes(topic)) continue;
    if (p.get("geo") && !geo.some((g: string) => g === p.get("geo") || g.startsWith(`${p.get("geo")}-`))) continue;
    if (from && publishedAt < from) continue;
    if (to && publishedAt > to) continue;
    let score = 0;
    if (phrases.length || words.length) {
      const h = headline.toLowerCase();
      const text = `${h} ${description.toLowerCase()}`;
      const matchAll = phrases.every((ph) => text.includes(ph)) && words.every((w) => text.includes(w));
      const matchAlt = expandedWith.some((a) => text.includes(a.toLowerCase()));
      if (!matchAll && !matchAlt) continue;
      score = (matchAll ? 10 : 4) + [...phrases, ...words].filter((t) => h.includes(t)).length * 3;
    }
    const ageDays = (Date.now() - Date.parse(publishedAt)) / 86_400_000;
    scored.push({ r, score: score + importance / 25 - ageDays / 7 });
  }
  const sort = p.get("sort") ?? "relevance";
  if (sort === "latest" || !(phrases.length || words.length)) scored.sort((a, b) => b.r[4].localeCompare(a.r[4]));
  else if (sort === "importance") scored.sort((a, b) => b.r[10] - a.r[10] || b.r[4].localeCompare(a.r[4]));
  else scored.sort((a, b) => b.score - a.score);
  const page = Math.max(1, Number(p.get("page")) || 1);
  const pageSize = 20;
  const terms = [...phrases, ...words];
  return {
    total: scored.length,
    page,
    pageSize,
    expandedWith,
    results: scored.slice((page - 1) * pageSize, page * pageSize).map(({ r }) => ({
      articleId: r[0],
      headline: r[1],
      description: r[2],
      snippet: terms.length ? snippet(r[2] || r[1], terms) : null,
      url: r[3],
      publishedAt: r[4],
      category: r[5],
      categoryLabel: label(r[5]),
      articleType: r[6],
      clusterId: r[7],
      clusterSize: r[11],
      importance: r[10],
      sourceId: r[8],
      sourceName: r[9],
      linkStatus: r[14],
    })),
  };
}

// ---- Handlers ----------------------------------------------------------------------------

const READER = { id: 1, email: "", display_name: "Reader", isAdmin: false, language: "en", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };

async function getHandler(path: string, p: URLSearchParams): Promise<any> {
  const P = await personalizer();
  let m: RegExpMatchArray | null;

  if (path === "session") return { user: READER, prefs: await prefs(), setupRequired: false, signupAllowed: false };
  if (path === "prefs") return { prefs: await prefs(), defaults: (await file("prefs")).defaults };
  if (path === "system/status") {
    const s = await file("system/status");
    return { ...s, health: { ...s.health, total: P.on.size, failing: s.health.failing.filter((f: any) => P.on.has(f.id)) } };
  }
  if (path === "notifications") return { unread: 0, items: [], channels: (await file("system/status")).notificationChannels ?? {} };
  if (path === "categories") return file("categories");

  if (path === "today") {
    const [d, pr] = await Promise.all([file("today"), prefs()]);
    const top = P.cards(d.top).slice(0, pr.homepage.topCount);
    const lead = P.visible(d.lead) ? d.lead : (top.shift() ?? null);
    const exported = new Map<string, any>(d.sections.map((s: any) => [s.key, s]));
    const sections = pr.homepage.sections
      .filter((s: any) => s.enabled && exported.has(s.key))
      .map((s: any) => {
        const e = exported.get(s.key);
        const stories = P.cards(e.stories);
        return { ...e, stories: stories.slice(0, s.count), total: stories.length };
      });
    const topicsFile = await file("topics");
    const followedTopics = topicsFile.topics.filter((t: any) => P.followed.has(t.id)).map((t: any) => ({ id: t.id, name: t.name, slug: t.slug, count: t.recentStories }));
    return {
      ...d,
      lead,
      top,
      breaking: P.cards(d.breaking),
      sections,
      sidebar: {
        ...d.sidebar,
        mostRead: [],
        developing: P.cards(d.sidebar.developing),
        recentlyUpdated: P.cards(d.sidebar.recentlyUpdated),
        followedTopics,
      },
    };
  }

  if (path === "live") {
    const d = await file("live");
    const hours = Math.min(72, Number(p.get("hours")) || 24);
    const since = new Date(Date.now() - hours * 3600_000).toISOString();
    const after = p.get("after");
    const filter = p.get("filter") ?? "all";
    const source = Number(p.get("source")) || null;
    let entries = d.entries.filter((e: any) => P.on.has(e.sourceId) && !e.topics.some((t: number) => P.muted.has(t)) && e.observedAt >= since && (!after || e.observedAt > after));
    if (filter === "breaking") entries = entries.filter((e: any) => e.isBreaking);
    if (filter === "developing") entries = entries.filter((e: any) => e.status === "developing");
    if (filter === "followed") entries = entries.filter((e: any) => e.topics.some((t: number) => P.followed.has(t)));
    if (p.get("category")) entries = entries.filter((e: any) => e.category === p.get("category"));
    if (source) entries = entries.filter((e: any) => e.sourceId === source);
    if (p.get("view") === "importance") entries.sort((a: any, b: any) => b.importance - a.importance);
    return { ...d, entries, serverTime: nowIso() };
  }

  if ((m = path.match(/^category\/([\w-]+)$/))) {
    const d = await file(`category/${m[1]}`);
    let stories = P.cards(d.stories);
    const hours = Number(p.get("hours")) || 0;
    if (hours) stories = stories.filter((s: any) => s.lastArticleAt >= new Date(Date.now() - hours * 3600_000).toISOString());
    const source = Number(p.get("source")) || null;
    if (source) stories = stories.filter((s: any) => s.sources.some((x: any) => x.id === source));
    const q = p.get("q")?.toLowerCase();
    if (q) stories = stories.filter((s: any) => `${s.headline} ${s.description ?? ""}`.toLowerCase().includes(q));
    if (p.get("status") === "developing") stories = stories.filter((s: any) => s.status === "developing");
    if (p.get("sort") === "latest") stories.sort((a: any, b: any) => b.lastUpdateAt.localeCompare(a.lastUpdateAt));
    const page = Math.max(1, Number(p.get("page")) || 1);
    return { ...d, total: stories.length, page, pageSize: 20, stories: stories.slice((page - 1) * 20, page * 20), sources: d.sources.filter((s: any) => P.on.has(s.id)) };
  }

  if ((m = path.match(/^story\/(\d+)$/))) {
    const id = Number(m[1]);
    const d = await file(`story/${id}`);
    const articles = d.articles.filter((a: any) => P.on.has(a.sourceId));
    if (!articles.length) return { hidden: true, hiddenCount: d.articles.length };
    const lastVisit = state.visits[id];
    if (p.get("visit") !== "0") {
      state.visits[id] = nowIso();
      recordHistory("story", id, d.headline);
    }
    return {
      ...d,
      articles,
      hiddenCount: d.articles.length - articles.length,
      related: P.cards(d.related),
      saved: isSaved("story", id, "saved"),
      following: isSaved("story", id, "following"),
      sinceLastVisit: lastVisit
        ? {
            lastVisitAt: lastVisit,
            events: d.timeline.filter((e: any) => e.significant && e.observedAt > lastVisit).map((e: any) => ({ at: e.at, kind: e.kind, text: e.text })),
            newArticles: articles.filter((a: any) => a.retrievedAt > lastVisit).length,
          }
        : null,
    };
  }

  if ((m = path.match(/^article\/(\d+)$/))) {
    const id = Number(m[1]);
    const a = await file(`article/${id}`);
    if (p.get("visit") !== "0") recordHistory("article", id, a.headline);
    return { ...a, source: { ...a.source, active: P.on.has(a.source.id) }, saved: isSaved("article", id, "saved"), readLater: isSaved("article", id, "later") };
  }

  if (path === "briefing/current") return file("briefing/current");
  if (path === "briefings") return file("briefings");
  if ((m = path.match(/^briefing\/(\d+)$/))) return file(`briefing/${m[1]}`);

  if (path === "archive") {
    const date = p.get("date") ?? new Date().toISOString().slice(0, 10);
    const { days } = await file("archive/days");
    const d = await file(`archive/${date}`).catch((e) => {
      if (e.status === 404) return { date, stories: [], briefings: [], pastEvents: [] };
      throw e;
    });
    return { ...d, stories: P.cards(d.stories), days };
  }

  if (path === "search") return search(p);
  if (path === "saved-searches") return { items: state.searches.map((s) => ({ ...s })) };

  if (path === "topics") {
    const d = await file("topics");
    return { topics: d.topics.map((t: any) => ({ ...t, state: state.topics[t.id] ?? null })) };
  }
  if ((m = path.match(/^topics\/(\d+)$/))) {
    const d = await file(`topics/${m[1]}`);
    return { ...d, topic: { ...d.topic, state: state.topics[d.topic.id] ?? null }, top: P.cards(d.top), recent: P.cards(d.recent) };
  }

  if (path === "saved") return { items: state.saved.map((s) => ({ ...s })), lists: [...new Set(state.saved.map((s) => s.list))] };
  if (path === "history") return { items: state.history.map((h) => ({ ...h })) };
  if (path === "upcoming") return file("upcoming");
  if (path === "weekly") return file("weekly");

  if (path === "sources") {
    const d = await file("sources");
    return {
      ...d,
      sources: d.sources.map((s: any) => ({ ...s, enabled: P.on.has(s.id), priority: state.sources[s.id]?.priority ?? 0, custom: false })),
    };
  }
  if (path === "sources/diversity") return file("sources/diversity");
  if ((m = path.match(/^sources\/(\d+)\/detail$/))) {
    const d = await file(`sources/detail/${m[1]}`);
    return { ...d, source: { ...d.source, enabled: P.on.has(d.source.id), priority: state.sources[d.source.id]?.priority ?? 0 } };
  }

  if (path.startsWith("admin")) throw new StaticError(403, LOCAL_ONLY);
  throw new StaticError(404, "Not found");
}

async function saveTarget(type: string, id: number) {
  if (type === "story") {
    const d = await file(`story/${id}`);
    return { id, headline: d.headline, category: d.category, last_update_at: d.lastUpdateAt, status: d.status, article_count: d.articles.length, source_count: d.card?.sourceCount ?? 1 };
  }
  if (type === "article") {
    const a = await file(`article/${id}`);
    return { id, headline: a.headline, description: a.description, canonical_url: a.url, published_at: a.publishedAt, link_status: a.linkStatus, cluster_id: a.clusterId, source_name: a.source.name };
  }
  const b = (await file(`briefing/${id}`)).briefing;
  return { id, edition_date: b.editionDate, edition: b.edition, generated_at: b.generatedAt, revision: b.revision };
}

async function writeHandler(method: string, path: string, body: any): Promise<any> {
  let m: RegExpMatchArray | null;
  const ok = (extra: object = {}) => (persist(), { ok: true, ...extra });

  if (path === "prefs" && method === "PUT") {
    state.prefs = deepMerge(state.prefs, body);
    persist();
    return { prefs: await prefs() };
  }
  if (path === "prefs/reset") {
    state.prefs = {};
    persist();
    return { prefs: await prefs() };
  }

  if (path === "saved") {
    const list = body.list ?? "saved";
    state.saved = state.saved.filter((s) => !(s.targetType === body.targetType && s.targetId === body.targetId && s.list === list));
    if (method === "POST") state.saved.unshift({ list, targetType: body.targetType, targetId: body.targetId, savedAt: nowIso(), readAt: null, note: body.note ?? null, target: await saveTarget(body.targetType, body.targetId) });
    return ok();
  }
  if (path === "saved/read") {
    for (const s of state.saved) if (s.targetType === body.targetType && s.targetId === body.targetId && s.list === body.list) s.readAt = body.read ? nowIso() : null;
    return ok();
  }
  if (path === "history" && method === "DELETE") {
    state.history = [];
    state.visits = {};
    return ok();
  }

  if (path === "saved-searches" && method === "POST") {
    const id = Date.now();
    state.searches.unshift({ id, name: body.name, query: body.query, alert: 0, created_at: nowIso() });
    persist();
    return { id };
  }
  if ((m = path.match(/^saved-searches\/(\d+)$/))) {
    const id = Number(m[1]);
    if (method === "DELETE") state.searches = state.searches.filter((s) => s.id !== id);
    else throw new StaticError(501, "Alerts need the full version of The Signal running on your computer.");
    return ok();
  }

  if ((m = path.match(/^topics\/(\d+)\/state$/))) {
    const id = Number(m[1]);
    if (body.state === "none") delete state.topics[id];
    else state.topics[id] = body.state;
    return ok();
  }

  if (path === "sources/selection") {
    for (const c of body.changes ?? []) state.sources[c.id] = { enabled: c.enabled, priority: c.priority ?? state.sources[c.id]?.priority ?? 0 };
    return ok({ active: (await sourceFilter()).size, queued: 0 });
  }
  if (path === "sources/restore-defaults") {
    state.sources = {};
    return ok({ active: (await sourceFilter()).size });
  }
  if ((m = path.match(/^sources\/preset\/([\w-]+)$/))) {
    const d = await file("sources");
    const preset = d.presets.find((x: any) => x.key === m![1]);
    if (!preset) throw new StaticError(404, "Unknown preset");
    for (const s of d.sources) {
      const inCategory = !preset.categories.length || preset.categories.includes(s.category);
      state.sources[s.id] = { enabled: inCategory && (preset.includeDisabledByDefault || s.defaultEnabled), priority: state.sources[s.id]?.priority ?? 0 };
    }
    return ok({ active: (await sourceFilter()).size });
  }

  if (path === "notifications/read-all" || /^notifications\/\d+\/read$/.test(path)) return { ok: true };
  if (path === "auth/logout") return { ok: true };
  throw new StaticError(501, LOCAL_ONLY);
}

/** Answer an /api request from the published edition and this browser's storage. */
export async function staticRequest(method: string, url: string, body?: any): Promise<any> {
  const u = new URL(url, "http://static.invalid");
  const path = u.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  if (method === "GET") return getHandler(path, u.searchParams);
  state = load(); // another tab may have changed it
  return writeHandler(method, path, body ?? {});
}

/** Poll for a newer published edition; calls back when one appears. */
export function watchEdition(onNew: () => void, everyMs = 5 * 60_000) {
  let last = "";
  const check = () =>
    edition()
      .then((m) => {
        if (last && m.version !== last) onNew();
        last = m.version;
      })
      .catch(() => undefined);
  check();
  const t = setInterval(check, everyMs);
  const onVisible = () => document.visibilityState === "visible" && check();
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    clearInterval(t);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
