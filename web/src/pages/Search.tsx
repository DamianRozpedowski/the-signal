import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, qs } from "../lib/api";
import { useApp } from "../lib/app";
import { ago, fmtDate } from "../lib/format";
import { Empty, ErrorState, ExternalLink, Loading, Toggle } from "../components/ui";

function Snippet({ text }: { text: string }) {
  const parts = text.split(/(\[\[.*?\]\])/g);
  return (
    <>
      {parts.map((p, i) => (p.startsWith("[[") ? <mark key={i}>{p.slice(2, -2)}</mark> : <span key={i}>{p}</span>))}
    </>
  );
}

const KEYS = ["q", "category", "topic", "sources", "from", "to", "type", "sort", "page"] as const;

export function SearchPage() {
  const [sp, setSp] = useSearchParams();
  const { toast } = useApp();
  const params = Object.fromEntries(KEYS.map((k) => [k, sp.get(k) ?? ""])) as Record<(typeof KEYS)[number], string>;
  const [q, setQ] = useState(params.q);
  const [res, setRes] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [meta, setMeta] = useState<{ cats: any[]; topics: any[]; sources: any[] }>({ cats: [], topics: [], sources: [] });
  const [saved, setSaved] = useState<any[]>([]);
  const loadSaved = () => api.get("/api/saved-searches").then((r) => setSaved(r.items)).catch(() => undefined);

  useEffect(() => setQ(params.q), [params.q]);
  useEffect(() => {
    Promise.all([api.get("/api/categories"), api.get("/api/topics"), api.get("/api/sources")])
      .then(([c, t, s]) => setMeta({ cats: c.categories, topics: t.topics, sources: s.sources.filter((x: any) => x.enabled) }))
      .catch(() => undefined);
    loadSaved();
  }, []);
  const key = sp.toString();
  useEffect(() => {
    const hasQuery = params.q || params.category || params.topic || params.sources || params.from;
    if (!hasQuery) {
      setRes(null);
      return;
    }
    setLoading(true);
    api
      .get(`/api/search${qs(params)}`)
      .then((r) => {
        setRes(r);
        setError(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [key]);

  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) v ? next.set(k, v) : next.delete(k);
    if (!("page" in patch)) next.delete("page");
    setSp(next);
  };
  const page = Number(params.page || 1);
  const pages = res ? Math.ceil(res.total / res.pageSize) : 1;

  return (
    <div className="page">
      <h1 className="hl hl-l">Search</h1>
      <form
        className="toolbar"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          set({ q: q.trim() });
        }}
      >
        <label htmlFor="sq" className="sr-only">Search terms</label>
        <input id="sq" type="search" className="grow" style={{ minWidth: 220 }} placeholder='Words, "exact phrases", people, places, organizations' value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn primary">Search</button>
      </form>
      <div className="toolbar">
        <select aria-label="Category" value={params.category} onChange={(e) => set({ category: e.target.value })}>
          <option value="">Any category</option>
          {meta.cats.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
        <select aria-label="Topic" value={params.topic} onChange={(e) => set({ topic: e.target.value })}>
          <option value="">Any topic</option>
          {meta.topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <select aria-label="Source" value={params.sources} onChange={(e) => set({ sources: e.target.value })}>
          <option value="">All my sources</option>
          {meta.sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select aria-label="Article type" value={params.type} onChange={(e) => set({ type: e.target.value })}>
          <option value="">Any type</option>
          <option value="news">News</option>
          <option value="analysis">Analysis</option>
          <option value="opinion">Opinion</option>
          <option value="press_release">Press release</option>
        </select>
        <label className="meta" htmlFor="from">From</label>
        <input id="from" type="date" value={params.from} onChange={(e) => set({ from: e.target.value })} />
        <label className="meta" htmlFor="to">to</label>
        <input id="to" type="date" value={params.to} onChange={(e) => set({ to: e.target.value })} />
        <select aria-label="Sort" value={params.sort || "relevance"} onChange={(e) => set({ sort: e.target.value })}>
          <option value="relevance">Most relevant</option>
          <option value="latest">Newest</option>
          <option value="importance">Most important</option>
        </select>
      </div>

      <div className="two-col">
        <div style={{ minWidth: 0 }}>
          {loading && <Loading lines={6} />}
          {error && <ErrorState error={error} />}
          {!res && !loading && <p className="meta">Search every article collected from your enabled sources. Use quotes for exact phrases.</p>}
          {res && !loading && (
            <>
              <div className="toolbar">
                <span className="meta">
                  {res.total} result{res.total === 1 ? "" : "s"}
                  {res.expandedWith?.length > 0 && ` · also matched related terms: ${res.expandedWith.join(", ")}`}
                </span>
                <span className="grow" />
                {params.q && (
                  <button
                    className="btn sm"
                    onClick={async () => {
                      const name = window.prompt("Name this saved search", params.q);
                      if (!name) return;
                      try {
                        const query = Object.fromEntries(Object.entries(params).filter(([k, v]) => v && k !== "page"));
                        await api.post("/api/saved-searches", { name, query, alert: false });
                        toast("Search saved");
                        loadSaved();
                      } catch (e: any) {
                        toast(e.message, "error");
                      }
                    }}
                  >
                    Save this search
                  </button>
                )}
              </div>
              {!res.results.length && <Empty title="No matching articles">Try fewer words, a wider date range, or check that the relevant sources are enabled.</Empty>}
              <div className="list">
                {res.results.map((r: any) => (
                  <div key={r.articleId}>
                    <div className="badges">
                      <span className="kicker">{r.categoryLabel}</span>
                      {r.articleType !== "news" && <span className="badge opinion">{r.articleType.replace("_", " ")}</span>}
                    </div>
                    <Link to={r.clusterId ? `/story/${r.clusterId}` : `/article/${r.articleId}`} style={{ fontWeight: 700, fontSize: "1.05rem", display: "block", margin: "4px 0" }}>
                      {r.headline}
                    </Link>
                    {r.snippet ? <p className="dek" style={{ fontSize: "0.92rem" }}><Snippet text={r.snippet} /></p> : r.description && <p className="dek" style={{ fontSize: "0.92rem" }}>{r.description.slice(0, 220)}</p>}
                    <div className="meta">
                      <span className="src">{r.sourceName}</span>
                      <span>{fmtDate(r.publishedAt)} ({ago(r.publishedAt)})</span>
                      {r.clusterSize > 1 && <span>{r.clusterSize} articles in story</span>}
                      <Link to={`/article/${r.articleId}`}>Article</Link>
                      <ExternalLink href={r.url}>Original</ExternalLink>
                    </div>
                  </div>
                ))}
              </div>
              {pages > 1 && (
                <div className="toolbar" style={{ marginTop: 16 }}>
                  <button className="btn sm" disabled={page <= 1} onClick={() => set({ page: String(page - 1) })}>Previous</button>
                  <span className="meta">Page {page} of {pages}</span>
                  <button className="btn sm" disabled={page >= pages} onClick={() => set({ page: String(page + 1) })}>Next</button>
                </div>
              )}
            </>
          )}
        </div>
        <aside className="rail">
          <div className="rail-box">
            <h2>Saved searches</h2>
            {!saved.length && <p className="meta">Save a search to rerun it later or get alerts when new matches arrive.</p>}
            <ul>
              {saved.map((s) => (
                <li key={s.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <Link to={`/search${qs(s.query)}`} style={{ flex: 1 }}>{s.name}</Link>
                  <Toggle
                    label={`Alerts for ${s.name}`}
                    checked={Boolean(s.alert)}
                    onChange={async (v) => {
                      await api.patch(`/api/saved-searches/${s.id}`, { alert: v });
                      toast(v ? "You'll be alerted about new matches" : "Alerts off");
                      loadSaved();
                    }}
                  />
                  <button className="btn sm ghost" aria-label={`Delete ${s.name}`} onClick={async () => { await api.del(`/api/saved-searches/${s.id}`); loadSaved(); }}>×</button>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
