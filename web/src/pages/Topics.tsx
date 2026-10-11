import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { useApp, useLoad } from "../lib/app";
import { fmtDate, fmtDateTime } from "../lib/format";
import { Empty, ErrorState, ExternalLink, Loading, StoryCard } from "../components/ui";
import { STATIC } from "../lib/static";

function StateButtons({ t, onChange }: { t: any; onChange: () => void }) {
  const { toast } = useApp();
  const setState = async (state: string) => {
    try {
      await api.post(`/api/topics/${t.id}/state`, { state });
      toast(state === "follow" ? `Following ${t.name}` : state === "mute" ? `${t.name} muted; major stories still appear` : `${t.name} reset`);
      onChange();
    } catch (e: any) {
      toast(e.message, "error");
    }
  };
  return (
    <div className="seg" role="group" aria-label={`Preference for ${t.name}`}>
      <button className={t.state === "follow" ? "on" : ""} aria-pressed={t.state === "follow"} onClick={() => setState(t.state === "follow" ? "none" : "follow")}>Follow</button>
      <button className={t.state === "mute" ? "on" : ""} aria-pressed={t.state === "mute"} onClick={() => setState(t.state === "mute" ? "none" : "mute")}>Mute</button>
    </div>
  );
}

function TopicForm({ initial, onDone }: { initial?: any; onDone: (id?: number) => void }) {
  const { toast } = useApp();
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [keywords, setKeywords] = useState((initial?.keywords ?? []).join(", "));
  const [categories, setCategories] = useState<string[]>(initial?.categories ?? []);
  const [matchMode, setMatchMode] = useState(initial?.matchMode ?? "any");
  const [cats, setCats] = useState<any[]>([]);
  useEffect(() => {
    api.get("/api/categories").then((r) => setCats(r.categories));
  }, []);
  return (
    <form
      className="panel"
      style={{ marginBottom: 20 }}
      onSubmit={async (e) => {
        e.preventDefault();
        const body = { name, description, keywords: keywords.split(",").map((k: string) => k.trim()).filter(Boolean), categories, matchMode };
        try {
          const r = initial ? await api.put(`/api/topics/${initial.id}`, body) : await api.post("/api/topics", body);
          toast(`${initial ? "Topic updated" : "Topic created and followed"}; ${r.matchedArticles} recent articles matched`);
          onDone(r.id ?? initial?.id);
        } catch (err: any) {
          toast(err.message, "error");
        }
      }}
    >
      <h2>{initial ? "Edit topic" : "Create a custom topic"}</h2>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="t-name">Name</label>
          <input id="t-name" type="text" required minLength={2} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="t-desc">Description (optional)</label>
          <input id="t-desc" type="text" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="t-kw">Keywords, people, companies or places</label>
        <input id="t-kw" type="text" value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="e.g. semiconductor, TSMC, chip export" />
        <span className="hint">Separate with commas. Whole words are matched in headlines and descriptions.</span>
      </div>
      <div className="field">
        <span className="label">Limit to categories (optional)</span>
        <div className="chips">
          {cats.map((c) => (
            <button
              type="button"
              key={c.key}
              className={`chip ${categories.includes(c.key) ? "on" : ""}`}
              aria-pressed={categories.includes(c.key)}
              onClick={() => setCategories(categories.includes(c.key) ? categories.filter((x) => x !== c.key) : [...categories, c.key])}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span className="label">Match</span>
        <div className="seg" role="group">
          <button type="button" className={matchMode === "any" ? "on" : ""} onClick={() => setMatchMode("any")}>Any keyword</button>
          <button type="button" className={matchMode === "all" ? "on" : ""} onClick={() => setMatchMode("all")}>All keywords</button>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn primary" type="submit">{initial ? "Save topic" : "Create topic"}</button>
        <button className="btn ghost" type="button" onClick={() => onDone()}>Cancel</button>
      </div>
    </form>
  );
}

export function Topics() {
  const { data, error, loading, reload } = useLoad<any>("/api/topics");
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState("all");
  const nav = useNavigate();
  const topics = (data?.topics ?? []).filter((t: any) => filter === "all" || (filter === "following" ? t.state === "follow" : filter === "muted" ? t.state === "mute" : t.custom));
  return (
    <div className="page">
      <h1 className="hl hl-l">Topics</h1>
      <p className="page-sub">Follow topics to see more of them and get alerts; mute topics to hide them except for major stories.</p>
      <div className="toolbar">
        <div className="chips" role="group" aria-label="Show">
          {["all", "following", "muted", "custom"].map((f) => (
            <button key={f} className={`chip ${filter === f ? "on" : ""}`} onClick={() => setFilter(f)}>{f[0].toUpperCase() + f.slice(1)}</button>
          ))}
        </div>
        <span className="grow" />
        {!STATIC && <button className="btn" onClick={() => setCreating(!creating)}>{creating ? "Close" : "Create a topic"}</button>}
      </div>
      {creating && <TopicForm onDone={(id) => { setCreating(false); if (id) nav(`/topics/${id}`); else reload(); }} />}
      {loading && !data && <Loading lines={6} />}
      {error && <ErrorState error={error} retry={() => reload()} />}
      {data && !topics.length && <Empty title="No topics here yet" />}
      <div className="grid-3">
        {topics.map((t: any) => (
          <div key={t.id} className="panel" style={{ marginTop: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            <div className="badges">
              {t.custom && <span className="badge neutral">Custom</span>}
              {t.state === "follow" && <span className="badge ok">Following</span>}
              {t.state === "mute" && <span className="badge warn">Muted</span>}
            </div>
            <Link to={`/topics/${t.id}`} className="hl hl-s">{t.name}</Link>
            {t.description && <p className="meta" style={{ margin: 0 }}>{t.description}</p>}
            <span className="meta">{t.recentStories} stories in the last 3 days</span>
            <StateButtons t={t} onChange={() => reload(true)} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function TopicPage() {
  const { id } = useParams();
  const { data, error, loading, reload } = useLoad<any>(`/api/topics/${id}`, { liveOn: ["cluster"] });
  const [editing, setEditing] = useState(false);
  const { toast } = useApp();
  const nav = useNavigate();
  if (loading && !data) return <div className="page"><Loading lines={8} /></div>;
  if (error) return <div className="page"><ErrorState error={error} retry={() => reload()} /></div>;
  if (!data) return null;
  const t = data.topic;
  const max = Math.max(1, ...data.trends.days.map((d: any) => d.articles));
  return (
    <div className="page">
      <Link to="/topics" className="meta">← All topics</Link>
      <div className="toolbar" style={{ marginTop: 8 }}>
        <h1 className="hl hl-l" style={{ margin: 0 }}>{t.name}</h1>
        <span className="grow" />
        <StateButtons t={t} onChange={() => reload(true)} />
        {t.custom && (
          <>
            <button className="btn sm" onClick={() => setEditing(!editing)}>{editing ? "Close" : "Edit"}</button>
            <button
              className="btn sm danger"
              onClick={async () => {
                if (!window.confirm(`Delete the topic “${t.name}”?`)) return;
                await api.del(`/api/topics/${t.id}`);
                toast("Topic deleted");
                nav("/topics");
              }}
            >
              Delete
            </button>
          </>
        )}
      </div>
      {t.description && <p className="page-sub">{t.description}</p>}
      {t.keywords.length > 0 && <p className="meta">Matches: {t.keywords.join(", ")} ({t.matchMode === "all" ? "all must match" : "any"})</p>}
      {editing && <TopicForm initial={t} onDone={() => { setEditing(false); reload(); }} />}

      <div className="two-col" style={{ marginTop: 16 }}>
        <div style={{ minWidth: 0 }}>
          <section>
            <div className="section-title"><h2>Most important</h2></div>
            {!data.top.length ? <Empty title="No stories on this topic in the last two weeks" /> : (
              <div className="list">{data.top.map((s: any) => <StoryCard key={s.id} s={s} variant="row" />)}</div>
            )}
          </section>
          {data.recent.length > 0 && (
            <section style={{ marginTop: 24 }}>
              <div className="section-title"><h2>Latest</h2></div>
              <div className="list">{data.recent.map((s: any) => <StoryCard key={s.id} s={s} variant="headline" />)}</div>
            </section>
          )}
        </div>
        <aside className="rail">
          <div className="rail-box">
            <h2>Coverage over 30 days</h2>
            <div className="bars" role="img" aria-label="Articles per day; darker bars show meaningful developments">
              {data.trends.days.map((d: any) => (
                <div key={d.day} className="bar" style={{ height: `${(d.articles / max) * 100}%` }} title={`${d.day}: ${d.articles} articles, ${d.stories} stories, ${d.developments} developments`}>
                  {d.developments > 0 && <div className="bar dev" style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: `${Math.min(100, (d.developments / Math.max(1, d.articles)) * 100)}%` }} />}
                </div>
              ))}
            </div>
            <p className="meta">Bar height is article volume; the colored portion marks meaningful developments. More articles does not always mean more news.</p>
            {data.trends.insights.length > 0 && <ul className="facts">{data.trends.insights.map((s: string, i: number) => <li key={i}>{s}</li>)}</ul>}
          </div>
          {data.timeline.length > 0 && (
            <div className="rail-box">
              <h2>Key developments</h2>
              <ul className="timeline" style={{ paddingLeft: 22 }}>
                {data.timeline.slice(0, 12).map((e: any) => (
                  <li key={e.id} className="sig" style={{ display: "block", border: 0 }}>
                    <div className="when">{fmtDateTime(e.at)}</div>
                    <Link to={`/story/${e.cluster_id}`}>{e.text}</Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {data.official.length > 0 && (
            <div className="rail-box">
              <h2>Official sources</h2>
              <ul>
                {data.official.map((o: any) => (
                  <li key={o.id}>
                    <ExternalLink href={o.canonical_url}>{o.headline}</ExternalLink>
                    <div className="meta"><span>{o.source_name}</span><span>{fmtDate(o.published_at)}</span></div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
