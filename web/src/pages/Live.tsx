import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, qs } from "../lib/api";
import { useApp } from "../lib/app";
import { ago, fmtTime } from "../lib/format";
import { Empty, ErrorState, ExternalLink, Loading } from "../components/ui";

const FILTERS = [
  ["all", "All"],
  ["breaking", "Breaking"],
  ["developing", "Developing"],
  ["followed", "Followed topics"],
] as const;

export function Live() {
  const { onLive, prefs } = useApp();
  const [filter, setFilter] = useState("all");
  const [view, setView] = useState("chronological");
  const [category, setCategory] = useState("");
  const [source, setSource] = useState("");
  const [entries, setEntries] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [freshIds, setFreshIds] = useState<Set<number>>(new Set());
  const [cats, setCats] = useState<any[]>([]);
  const [srcs, setSrcs] = useState<any[]>([]);
  const latest = useRef<string | null>(null);
  const params = { filter, view, category, source };
  const mode = prefs?.liveUpdates ?? "realtime";

  const load = useCallback(async () => {
    try {
      const r = await api.get(`/api/live${qs(params)}`);
      setEntries(r.entries);
      latest.current = r.entries.reduce((m: string | null, e: any) => (!m || e.observedAt > m ? e.observedAt : m), null) ?? r.serverTime;
      setPending(0);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, [filter, view, category, source]);

  const fetchNew = useCallback(async () => {
    if (!latest.current) return load();
    const r = await api.get(`/api/live${qs({ ...params, after: latest.current })}`);
    if (!r.entries.length) return;
    latest.current = r.entries.reduce((m: string, e: any) => (e.observedAt > m ? e.observedAt : m), latest.current!);
    setFreshIds(new Set(r.entries.map((e: any) => e.id)));
    setEntries((prev) => {
      const ids = new Set(r.entries.map((e: any) => e.id));
      const merged = [...r.entries, ...(prev ?? []).filter((e) => !ids.has(e.id))];
      return view === "importance" ? merged.sort((a, b) => b.importance - a.importance) : merged;
    });
  }, [filter, view, category, source]);

  useEffect(() => {
    setEntries(null);
    load();
  }, [load]);

  useEffect(() => {
    api.get("/api/categories").then((r) => setCats(r.categories)).catch(() => undefined);
    api.get("/api/sources").then((r) => setSrcs(r.sources.filter((s: any) => s.enabled))).catch(() => undefined);
  }, []);

  useEffect(() => {
    let t: any;
    return onLive((type) => {
      if (type !== "articles" && type !== "cluster") return;
      if (mode === "realtime" && window.scrollY < 300) {
        clearTimeout(t);
        t = setTimeout(() => fetchNew().catch(() => undefined), 1000);
      } else setPending((n) => n + 1);
    });
  }, [onLive, fetchNew, mode]);

  useEffect(() => {
    if (mode !== "every5") return;
    const t = setInterval(() => setPending((p) => (p ? (fetchNew(), 0) : 0)), 5 * 60_000);
    return () => clearInterval(t);
  }, [mode, fetchNew]);

  return (
    <div className="page">
      <h1 className="hl hl-l" style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span className="dot live" aria-hidden="true" /> Live News
      </h1>
      <p className="page-sub">New stories and meaningful developments as they are collected from your sources. Repeat reports of the same story are folded into it.</p>
      <div className="toolbar">
        <div className="chips" role="group" aria-label="Filter">
          {FILTERS.map(([k, l]) => (
            <button key={k} className={`chip ${filter === k ? "on" : ""}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>
          ))}
        </div>
        <span className="grow" />
        <label className="sr-only" htmlFor="live-cat">Category</label>
        <select id="live-cat" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {cats.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
        <label className="sr-only" htmlFor="live-src">Source</label>
        <select id="live-src" value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">All my sources</option>
          {srcs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <div className="seg" role="group" aria-label="Order">
          <button className={view === "chronological" ? "on" : ""} onClick={() => setView("chronological")}>Latest</button>
          <button className={view === "importance" ? "on" : ""} onClick={() => setView("importance")}>Most important</button>
        </div>
      </div>
      {pending > 0 && (
        <div className="new-banner">
          <button className="btn primary sm" onClick={() => { fetchNew(); setPending(0); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
            New updates available. Show them
          </button>
        </div>
      )}
      {error && <ErrorState error={error} retry={load} />}
      {!entries && !error && <Loading lines={8} />}
      {entries && !entries.length && (
        <Empty title="Nothing new in the last 24 hours">
          {filter !== "all" || category || source ? "Try removing filters." : "When your sources publish new stories or developments, they will appear here automatically."}
        </Empty>
      )}
      {entries && entries.length > 0 && (
        <ol className="timeline" aria-live="polite" style={{ maxWidth: 820 }}>
          {entries.map((e) => (
            <li key={e.id} className={`${e.isNewStory ? "" : "sig"} ${freshIds.has(e.id) ? "fresh" : ""}`}>
              <div className="when">
                <time dateTime={e.observedAt} title={`Collected ${fmtTime(e.observedAt)}; published ${fmtTime(e.publishedAt)}`}>{fmtTime(e.observedAt)}</time> · {ago(e.observedAt)} ·{" "}
                {e.isNewStory ? "New story" : e.kind === "official" ? "Official statement" : e.kind === "correction" ? "Correction" : e.kind === "new_source" ? "Also reports" : "Development"}
              </div>
              <div className="badges" style={{ margin: "4px 0" }}>
                <span className="kicker">{e.categoryLabel}</span>
                {e.isBreaking && <span className="badge breaking">Breaking</span>}
                {e.status === "developing" && <span className="badge developing">Developing</span>}
              </div>
              <Link to={`/story/${e.clusterId}`} style={{ fontWeight: 700, fontSize: "1.05rem" }}>{e.isNewStory ? e.headline : e.storyHeadline}</Link>
              {!e.isNewStory && <div style={{ marginTop: 2 }}>{e.text}</div>}
              {e.isNewStory && e.description && <div className="dek" style={{ fontSize: "0.95rem" }}>{e.description.slice(0, 260)}</div>}
              <div className="meta" style={{ marginTop: 4 }}>
                <ExternalLink href={e.url}>{e.sourceName}</ExternalLink>
                {e.sourceCount > 1 && <span>{e.sourceCount} sources on this story</span>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
