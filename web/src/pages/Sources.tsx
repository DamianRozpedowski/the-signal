import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { useApp, useLoad } from "../lib/app";
import { ago, fmtDateTime, hostOf } from "../lib/format";
import { Empty, ErrorState, ExternalLink, Loading, SourceStatus } from "../components/ui";
import { STATIC } from "../lib/static";

const KIND_LABEL: Record<string, string> = {
  publisher: "Publisher",
  public_broadcaster: "Public broadcaster",
  wire: "Wire service",
  official: "Official / government",
  analysis: "Analysis",
  aggregator: "Aggregator",
};
const PRIORITY_LABEL: Record<number, string> = { [-2]: "Much less", [-1]: "Less", 0: "Normal", 1: "More", 2: "Much more" };

export function Sources() {
  const [sp, setSp] = useSearchParams();
  const { data, error, loading, reload } = useLoad<any>("/api/sources", { liveOn: ["source"] });
  const { toast, reloadStatus } = useApp();
  const [q, setQ] = useState("");
  const filter = sp.get("filter") ?? "all";
  const category = sp.get("category") ?? "";
  const [sort, setSort] = useState("name");
  const [changes, setChanges] = useState<Map<number, { enabled: boolean; priority: number }>>(new Map());
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [tab, setTab] = useState<"checklist" | "diversity">("checklist");

  const setParam = (k: string, v: string) => {
    const n = new URLSearchParams(sp);
    v ? n.set(k, v) : n.delete(k);
    setSp(n);
  };

  const sources: any[] = data?.sources ?? [];
  const effective = (s: any) => changes.get(s.id) ?? { enabled: s.enabled, priority: s.priority };
  const visible = useMemo(() => {
    const ql = q.trim().toLowerCase();
    let list = sources.filter((s) => {
      const e = effective(s);
      if (ql && !`${s.name} ${s.description} ${hostOf(s.siteUrl || s.feedUrl)}`.toLowerCase().includes(ql)) return false;
      if (category && s.category !== category) return false;
      if (filter === "enabled" && !e.enabled) return false;
      if (filter === "disabled" && e.enabled) return false;
      if (filter === "failing" && !(s.status === "error" || s.status === "degraded")) return false;
      if (filter === "custom" && !s.custom) return false;
      if (filter === "official" && s.kind !== "official") return false;
      return true;
    });
    const health = (s: any) => ({ error: 0, degraded: 1, pending: 2, disabled: 3, ok: 4 } as any)[s.status] ?? 5;
    list = [...list].sort((a, b) =>
      sort === "category" ? a.category.localeCompare(b.category) || a.name.localeCompare(b.name)
      : sort === "health" ? health(a) - health(b)
      : sort === "updated" ? (b.lastSuccessAt ?? "").localeCompare(a.lastSuccessAt ?? "")
      : sort === "volume" ? (b.articles24h ?? 0) - (a.articles24h ?? 0)
      : a.name.localeCompare(b.name),
    );
    return list;
  }, [sources, q, filter, category, sort, changes]);

  const setMany = (list: any[], enabled: boolean) => {
    const m = new Map(changes);
    for (const s of list) {
      if (s.adminDisabled) continue;
      const e = effective(s);
      if (enabled === s.enabled && e.priority === s.priority) m.delete(s.id);
      else m.set(s.id, { ...e, enabled });
    }
    setChanges(m);
  };
  const setOne = (s: any, patch: Partial<{ enabled: boolean; priority: number }>) => {
    const m = new Map(changes);
    const next = { ...effective(s), ...patch };
    if (next.enabled === s.enabled && next.priority === s.priority) m.delete(s.id);
    else m.set(s.id, next);
    setChanges(m);
  };

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.put("/api/sources/selection", { changes: [...changes.entries()].map(([id, c]) => ({ id, ...c })) });
      toast(`Saved. ${r.active} sources active${r.queued ? `; fetching ${r.queued} new source${r.queued === 1 ? "" : "s"} now` : ""}.`);
      setChanges(new Map());
      reload(true);
      reloadStatus();
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setSaving(false);
    }
  };

  const enabledCount = sources.filter((s) => effective(s).enabled).length;
  const failing = sources.filter((s) => effective(s).enabled && (s.status === "error" || s.status === "degraded")).length;

  return (
    <div className="page">
      <h1 className="hl hl-l">Sources</h1>
      <p className="page-sub">
        Your newspaper is built only from the sources you enable here. {enabledCount} of {sources.length} enabled{failing ? `, ${failing} currently failing` : ""}.
      </p>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "checklist"} className={tab === "checklist" ? "on" : ""} onClick={() => setTab("checklist")}>Checklist</button>
        <button role="tab" aria-selected={tab === "diversity"} className={tab === "diversity" ? "on" : ""} onClick={() => setTab("diversity")}>Coverage balance</button>
      </div>
      {tab === "diversity" ? (
        <Diversity />
      ) : (
        <>
          <Presets presets={data?.presets ?? []} onApplied={() => { setChanges(new Map()); reload(true); reloadStatus(); }} />
          <div className="toolbar">
            <label htmlFor="src-q" className="sr-only">Search sources</label>
            <input id="src-q" type="search" placeholder="Search sources" value={q} onChange={(e) => setQ(e.target.value)} />
            <select aria-label="Show" value={filter} onChange={(e) => setParam("filter", e.target.value === "all" ? "" : e.target.value)}>
              <option value="all">All sources</option>
              <option value="enabled">Enabled</option>
              <option value="disabled">Disabled</option>
              <option value="failing">Failing</option>
              <option value="official">Official sources</option>
              <option value="custom">Added by me</option>
            </select>
            <select aria-label="Category" value={category} onChange={(e) => setParam("category", e.target.value)}>
              <option value="">All categories</option>
              {data?.categories.map((c: any) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
            <select aria-label="Sort by" value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="name">Sort: name</option>
              <option value="category">Sort: category</option>
              <option value="health">Sort: health (problems first)</option>
              <option value="updated">Sort: last updated</option>
              <option value="volume">Sort: articles in 24h</option>
            </select>
            <span className="grow" />
            {!STATIC && <button className="btn" onClick={() => setAdding(!adding)} aria-expanded={adding}>{adding ? "Close" : "Add a source"}</button>}
          </div>
          {adding && <AddSource categories={data?.categories ?? []} onAdded={() => { setAdding(false); reload(true); reloadStatus(); }} />}
          <div className="toolbar" style={{ position: "sticky", top: 58, zIndex: 10, background: "var(--paper)", padding: "8px 0", margin: 0 }}>
            <button className="btn sm" onClick={() => setMany(visible, true)}>Select all{visible.length !== sources.length ? " shown" : ""}</button>
            <button className="btn sm" onClick={() => setMany(visible, false)}>Select none{visible.length !== sources.length ? " shown" : ""}</button>
            <button
              className="btn sm ghost"
              onClick={async () => {
                if (!window.confirm("Restore the default source selection? Your custom sources stay registered but are turned off.")) return;
                await api.post("/api/sources/restore-defaults");
                setChanges(new Map());
                toast("Default sources restored");
                reload(true);
                reloadStatus();
              }}
            >
              Restore defaults
            </button>
            <span className="grow" />
            {changes.size > 0 && <span className="meta">{changes.size} unsaved change{changes.size === 1 ? "" : "s"}</span>}
            {changes.size > 0 && <button className="btn sm ghost" onClick={() => setChanges(new Map())}>Discard</button>}
            <button className="btn primary sm" disabled={!changes.size || saving} onClick={save}>{saving ? "Saving…" : "Save changes"}</button>
          </div>
          {loading && !data && <Loading lines={10} />}
          {error && <ErrorState error={error} retry={() => reload()} />}
          {data && !visible.length && <Empty title="No sources match" />}
          {visible.length > 0 && (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th style={{ width: 40 }}><span className="sr-only">Enabled</span></th>
                    <th>Source</th>
                    <th>Category</th>
                    <th>Health</th>
                    <th>Last updated</th>
                    <th>24h</th>
                    <th>Priority</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((s) => {
                    const e = effective(s);
                    return (
                      <SourceRow key={s.id} s={s} e={e} dirty={changes.has(s.id)} open={open === s.id} onToggleOpen={() => setOpen(open === s.id ? null : s.id)} onChange={(p: any) => setOne(s, p)} onRemoved={() => reload(true)} categories={data.categories} />
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SourceRow({ s, e, dirty, open, onToggleOpen, onChange, onRemoved, categories }: any) {
  const catLabel = categories.find((c: any) => c.key === s.category)?.label ?? s.category;
  return (
    <>
      <tr className={dirty ? "dirty" : ""}>
        <td>
          <input
            type="checkbox"
            className="check"
            style={{ width: 18, height: 18, accentColor: "var(--accent)" }}
            checked={e.enabled}
            disabled={s.adminDisabled}
            onChange={(ev) => onChange({ enabled: ev.target.checked })}
            aria-label={`Include ${s.name}`}
          />
        </td>
        <td>
          <div className="src-name">
            {s.favicon && <img src={s.favicon} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(ev) => ((ev.target as HTMLElement).style.visibility = "hidden")} />}
            <div>
              <button className="btn ghost sm" style={{ padding: 0, minHeight: 0, fontWeight: 700, fontSize: "0.9rem" }} onClick={onToggleOpen} aria-expanded={open}>
                {s.name}
              </button>
              <div className="meta" style={{ fontSize: "0.76rem" }}>
                <span>{KIND_LABEL[s.kind] ?? s.kind}</span>
                {s.region && <span>{s.region}</span>}
                <span>{s.integration.toUpperCase()}</span>
                {s.custom && <span className="badge neutral">Added by you</span>}
                {s.defaultEnabled && <span>Default</span>}
              </div>
            </div>
          </div>
        </td>
        <td>{catLabel}</td>
        <td><SourceStatus status={s.status} error={s.lastError} /></td>
        <td title={s.lastSuccessAt ? fmtDateTime(s.lastSuccessAt) : undefined}>{s.lastSuccessAt ? ago(s.lastSuccessAt) : "Never"}</td>
        <td>{s.articles24h}</td>
        <td>
          <select aria-label={`Priority for ${s.name}`} value={e.priority} onChange={(ev) => onChange({ priority: Number(ev.target.value) })} disabled={!e.enabled} style={{ minHeight: 30, padding: "2px 6px" }}>
            {[-2, -1, 0, 1, 2].map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
          </select>
        </td>
      </tr>
      {open && (
        <tr>
          <td />
          <td colSpan={6}>
            <SourceDetail s={s} onRemoved={onRemoved} />
          </td>
        </tr>
      )}
    </>
  );
}

function SourceDetail({ s, onRemoved }: { s: any; onRemoved: () => void }) {
  const { data } = useLoad<any>(`/api/sources/${s.id}/detail`);
  const { toast } = useApp();
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {s.description && <p style={{ margin: 0 }}>{s.description}</p>}
      <div className="meta">
        {s.siteUrl && <ExternalLink href={s.siteUrl}>{hostOf(s.siteUrl)}</ExternalLink>}
        <span className="mono">{s.feedUrl}</span>
      </div>
      <div className="meta">
        <span>Checked every {s.intervalMinutes} min</span>
        {s.observedItemsPerDay != null && <span>about {Math.round(s.observedItemsPerDay)} items/day</span>}
        <span>{s.articleCount} articles collected</span>
        {s.lastAttemptAt && <span>Last attempt {ago(s.lastAttemptAt)}</span>}
        {s.lastNewItemAt && <span>Last new item {ago(s.lastNewItemAt)}</span>}
        {s.nextFetchAt && <span>Next check {fmtDateTime(s.nextFetchAt)}</span>}
      </div>
      {s.lastError && <div className="notice error"><div><strong>Last error</strong>{s.lastError}</div></div>}
      <div style={{ display: "flex", gap: 8 }}>
        {!STATIC && <button
          className="btn sm"
          disabled={s.adminDisabled}
          onClick={async () => {
            try {
              const r = await api.post(`/api/sources/${s.id}/refresh`);
              toast(r.queued ? `Checking ${s.name} now` : `${s.name} is already being checked`);
            } catch (e: any) {
              toast(e.message, "error");
            }
          }}
        >
          Check now
        </button>}
        {s.custom && (
          <button
            className="btn sm danger"
            onClick={async () => {
              if (!window.confirm(`Remove ${s.name} and its collected articles?`)) return;
              try {
                await api.del(`/api/sources/${s.id}`);
                toast(`${s.name} removed`);
                onRemoved();
              } catch (e: any) {
                toast(e.message, "error");
              }
            }}
          >
            Remove source
          </button>
        )}
      </div>
      {data && (
        <div className="grid-2">
          <div>
            <div className="label">Recent articles</div>
            {!data.recent.length ? <p className="meta">None collected yet.</p> : (
              <ul className="facts">
                {data.recent.slice(0, 6).map((a: any) => (
                  <li key={a.id}><Link to={a.cluster_id ? `/story/${a.cluster_id}` : `/article/${a.id}`}>{a.headline}</Link> <span className="meta" style={{ display: "inline" }}>{ago(a.published_at)}</span></li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <div className="label">Recent checks</div>
            {!data.jobs.length ? <p className="meta">Not checked yet.</p> : (
              <ul className="facts">
                {data.jobs.slice(0, 6).map((j: any) => (
                  <li key={j.id}>
                    {fmtDateTime(j.started_at)}: {j.status === "ok" ? `${j.items_new ?? 0} new of ${j.items_found ?? 0}` : j.status === "not_modified" ? "no changes" : j.status}
                    {j.error && <span className="meta" style={{ display: "inline" }}> ({j.error})</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Presets({ presets, onApplied }: { presets: any[]; onApplied: () => void }) {
  const { toast } = useApp();
  return (
    <details className="source-entry" style={{ marginBottom: 14 }}>
      <summary><strong>Quick setup presets</strong><span className="meta" style={{ marginLeft: 8 }}>Replace your selection with a ready-made set</span></summary>
      <div className="inner">
        <div className="grid-3">
          {presets.map((p) => (
            <div key={p.key} className="callout">
              <h3>{p.name}</h3>
              <p style={{ margin: "0 0 8px", fontSize: "0.88rem" }}>{p.description}</p>
              <button
                className="btn sm"
                onClick={async () => {
                  if (!window.confirm(`Apply the “${p.name}” preset? This replaces your current source selection.`)) return;
                  try {
                    const r = await api.post(`/api/sources/preset/${p.key}`);
                    toast(`${p.name} applied: ${r.active} sources active`);
                    onApplied();
                  } catch (e: any) {
                    toast(e.message, "error");
                  }
                }}
              >
                Apply
              </button>
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}

function AddSource({ categories, onAdded }: { categories: any[]; onAdded: () => void }) {
  const { toast } = useApp();
  const [url, setUrl] = useState("");
  const [report, setReport] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("world");
  const [kind, setKind] = useState("publisher");
  const [interval, setIntervalMin] = useState(30);
  useEffect(() => {
    if (report?.feed?.title) setName(report.feed.title);
  }, [report]);
  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <h2>Add a source</h2>
      <p className="meta" style={{ marginTop: 0 }}>Paste an RSS or Atom feed URL, or a website address and the feed will be discovered. The feed is checked before it is added.</p>
      <form
        className="toolbar"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setReport(null);
          try {
            setReport(await api.post("/api/sources/validate", { url }));
          } catch (err: any) {
            toast(err.message, "error");
          } finally {
            setBusy(false);
          }
        }}
      >
        <label htmlFor="add-url" className="sr-only">Feed or website URL</label>
        <input id="add-url" type="url" className="grow" required placeholder="https://example.com/feed.xml" value={url} onChange={(e) => { setUrl(e.target.value); setReport(null); }} />
        <button className="btn" disabled={busy}>{busy ? "Checking…" : "Check feed"}</button>
      </form>
      {report && (
        <>
          <ul className="facts" style={{ listStyle: "none", paddingLeft: 0 }}>
            {report.checks.map((c: any) => (
              <li key={c.key}>
                <span className={`badge ${c.ok ? "ok" : "err"}`} style={{ marginRight: 8 }}>{c.ok ? "Pass" : "Fail"}</span>
                <strong>{c.label}</strong>: {c.detail}
              </li>
            ))}
          </ul>
          {report.discoveredFeedUrl && <p className="meta">Feed discovered at <span className="mono">{report.discoveredFeedUrl}</span></p>}
          {report.feed && (
            <div className="callout" style={{ margin: "10px 0" }}>
              <h3>Preview: {report.feed.title} ({report.feed.format.toUpperCase()}, {report.feed.itemCount} items)</h3>
              <ul className="facts">
                {report.feed.sample.map((s: any, i: number) => (
                  <li key={i}><ExternalLink href={s.url}>{s.title}</ExternalLink> {s.publishedAt && <span className="meta" style={{ display: "inline" }}>{ago(s.publishedAt)}</span>}</li>
                ))}
              </ul>
            </div>
          )}
          {report.ok ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                try {
                  const r = await api.post("/api/sources", { url, name, category, kind, intervalMinutes: interval });
                  const o = r.outcome;
                  toast(o?.status === "ok" ? `${name} added: ${o.stats?.new ?? 0} articles collected` : `${name} added; first fetch: ${o?.status ?? "queued"}${o?.error ? ` (${o.error})` : ""}`);
                  onAdded();
                } catch (err: any) {
                  toast(err.message, "error");
                } finally {
                  setBusy(false);
                }
              }}
            >
              <div className="grid-2">
                <div className="field">
                  <label htmlFor="add-name">Name</label>
                  <input id="add-name" type="text" required minLength={2} value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="add-cat">Category</label>
                  <select id="add-cat" value={category} onChange={(e) => setCategory(e.target.value)}>
                    {categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="add-kind">Type of source</label>
                  <select id="add-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
                    {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="add-int">Check every</label>
                  <select id="add-int" value={interval} onChange={(e) => setIntervalMin(Number(e.target.value))}>
                    {[15, 30, 60, 120, 360].map((m) => <option key={m} value={m}>{m < 60 ? `${m} minutes` : `${m / 60} hour${m > 60 ? "s" : ""}`}</option>)}
                  </select>
                </div>
              </div>
              <button className="btn primary" disabled={busy}>{busy ? "Adding…" : "Add source"}</button>
            </form>
          ) : (
            <div className="notice error"><div><strong>This source can't be added</strong>Fix the failed checks above and try again.</div></div>
          )}
        </>
      )}
    </div>
  );
}

function Diversity() {
  const { data, error, loading } = useLoad<any>("/api/sources/diversity");
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} />;
  if (!data.total) return <Empty title="No sources enabled" />;
  const bar = (rows: any[], key: string, label: (k: string) => string) => {
    const total = rows.reduce((n, r) => n + r.n, 0) || 1;
    return (
      <ul className="facts" style={{ listStyle: "none", paddingLeft: 0 }}>
        {[...rows].sort((a, b) => b.n - a.n).map((r) => (
          <li key={r[key]} style={{ display: "grid", gridTemplateColumns: "160px 1fr 40px", gap: 8, alignItems: "center" }}>
            <span>{label(r[key])}</span>
            <span style={{ background: "var(--paper-2)", borderRadius: 3, height: 10 }}><span style={{ display: "block", height: "100%", width: `${(r.n / total) * 100}%`, background: "var(--accent)", borderRadius: 3 }} /></span>
            <span className="meta">{r.n}</span>
          </li>
        ))}
      </ul>
    );
  };
  const c = data.corroboration ?? {};
  return (
    <div>
      <p className="page-sub">How your {data.total} enabled sources are balanced. These are descriptive attributes, not ratings of truthfulness.</p>
      <div className="grid-2">
        <div className="panel"><h2>Types of source</h2>{bar(data.byKind, "kind", (k) => KIND_LABEL[k] ?? k)}</div>
        <div className="panel" style={{ marginTop: 0 }}><h2>Sections covered</h2>{bar(data.byCategory, "category", (k) => k)}</div>
        <div className="panel"><h2>Regions</h2>{bar(data.byRegion, "region", (k) => k)}</div>
        <div className="panel">
          <h2>Article types (7 days)</h2>
          {data.articleTypes.length ? bar(data.articleTypes, "article_type", (k) => k.replace("_", " ")) : <p className="meta">No articles yet.</p>}
        </div>
        <div className="panel">
          <h2>Corroboration (7 days)</h2>
          <p>{c.multi ?? 0} stories reported by two or more sources; {c.single ?? 0} by a single source; {c.official ?? 0} with an official source.</p>
        </div>
        <div className="panel">
          <h2>Corrections issued</h2>
          {data.corrections.length ? <ul className="facts">{data.corrections.map((r: any) => <li key={r.name}>{r.name}: {r.n}</li>)}</ul> : <p className="meta">No corrections or retractions detected in your sources' feeds.</p>}
        </div>
      </div>
    </div>
  );
}
