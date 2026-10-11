import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import { api, qs } from "../lib/api";
import { useApp, useLoad } from "../lib/app";
import { ago, fmtDateTime } from "../lib/format";
import { ConfigNotice, Empty, ErrorState, Loading, SourceStatus } from "../components/ui";

const TABS = [
  ["overview", "Overview"],
  ["sources", "Sources"],
  ["jobs", "Ingestion jobs"],
  ["duplicates", "Duplicates"],
  ["clusters", "Clustering"],
  ["ai", "AI processing"],
  ["briefings", "Briefings"],
  ["notifications", "Notifications"],
  ["ranking", "Ranking"],
  ["diagnose", "Diagnose"],
  ["logs", "Logs"],
  ["users", "Users"],
] as const;

export function Admin() {
  const [tab, setTab] = useState<string>("overview");
  return (
    <div className="page">
      <h1 className="hl hl-l">Administration</h1>
      <p className="page-sub">Monitor collection, processing and delivery. Every action here is logged.</p>
      <div className="tabs" role="tablist">
        {TABS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === "overview" && <Overview />}
      {tab === "sources" && <AdminSources />}
      {tab === "jobs" && <Jobs />}
      {tab === "duplicates" && <Duplicates />}
      {tab === "clusters" && <Clusters />}
      {tab === "ai" && <AiJobs />}
      {tab === "briefings" && <Briefings />}
      {tab === "notifications" && <Notifications />}
      {tab === "ranking" && <Ranking />}
      {tab === "diagnose" && <Diagnose />}
      {tab === "logs" && <Logs />}
      {tab === "users" && <Users />}
    </div>
  );
}

function Wrap({ url, children, live }: { url: string; children: (d: any, reload: () => void) => any; live?: string[] }) {
  const { data, error, loading, reload } = useLoad<any>(url, { liveOn: live });
  if (loading && !data) return <Loading lines={6} />;
  if (error) return <ErrorState error={error} retry={() => reload()} />;
  return data ? children(data, () => reload(true)) : null;
}

function Stat({ n, label }: { n: any; label: string }) {
  return <div className="stat"><b>{n ?? 0}</b><span>{label}</span></div>;
}

function Overview() {
  const { toast } = useApp();
  return (
    <Wrap url="/api/admin/overview" live={["source", "refresh"]}>
      {(d, reload) => (
        <>
          {d.ai.status !== "configured" && <ConfigNotice title="AI processing is not configured">{d.ai.message}</ConfigNotice>}
          <div className="grid-3" style={{ margin: "16px 0" }}>
            <div className="panel" style={{ marginTop: 0 }}>
              <h2>Sources</h2>
              <div style={{ display: "flex", gap: 24 }}>
                <Stat n={d.counts.sources.n} label="registered" />
                <Stat n={d.counts.sources.failing} label="failing" />
                <Stat n={d.counts.sources.disabled} label="disabled" />
              </div>
            </div>
            <div className="panel" style={{ marginTop: 0 }}>
              <h2>Articles</h2>
              <div style={{ display: "flex", gap: 24 }}>
                <Stat n={d.counts.articles.n} label="total" />
                <Stat n={d.counts.articles.last24h} label="last 24h" />
                <Stat n={d.counts.duplicates24h} label="duplicates 24h" />
              </div>
            </div>
            <div className="panel" style={{ marginTop: 0 }}>
              <h2>Stories</h2>
              <div style={{ display: "flex", gap: 24 }}>
                <Stat n={d.counts.clusters.active24h} label="active 24h" />
                <Stat n={d.counts.clusters.breaking} label="breaking" />
                <Stat n={d.counts.clusters.awaitingSummary} label="awaiting summary" />
              </div>
            </div>
          </div>
          <div className="grid-2">
            <div className="panel" style={{ marginTop: 0 }}>
              <h2>Scheduler</h2>
              <p>
                {d.queue.schedulerActive ? "Running" : "Stopped"} · last tick {d.queue.lastTickAt ? ago(d.queue.lastTickAt) : "never"} · {d.queue.running.length} fetching, {d.queue.queued.length} queued
              </p>
              <p className="meta">Jobs in last 24h: {d.jobs24h.map((j: any) => `${j.status} ${j.n}`).join(" · ") || "none"}</p>
              <p className="meta">Clustering index: {JSON.stringify(d.index)}</p>
              <button
                className="btn sm"
                onClick={async () => {
                  const r = await api.post("/api/admin/ingest-all");
                  toast(`${r.queued} sources queued`);
                  reload();
                }}
              >
                Fetch all sources now
              </button>
            </div>
            <div className="panel" style={{ marginTop: 0 }}>
              <h2>Processing and delivery</h2>
              <p>AI: {d.ai.status}{d.ai.model ? ` (${d.ai.model})` : ""}{d.ai.lastError ? ` · last error ${ago(d.ai.lastError.finished_at)}: ${d.ai.lastError.error}` : ""}</p>
              {d.ai.usage24h.length > 0 && (
                <p className="meta">
                  24h: {d.ai.usage24h.map((u: any) => `${u.kind} ${u.status} ×${u.n} (${u.input_tokens ?? 0} in / ${u.output_tokens ?? 0} out tokens)`).join(" · ")}
                </p>
              )}
              <p>Notification delivery failures (24h): {d.notificationFailures24h}</p>
              <p>Articles with processing errors: {d.processingFailures}</p>
              <p>Last briefing: {d.lastBriefing ? `${fmtDateTime(d.lastBriefing.generated_at)} (${d.lastBriefing.edition}, AI ${d.lastBriefing.ai_status})` : "none yet"}</p>
              <p>Users: {d.counts.users}</p>
            </div>
          </div>
        </>
      )}
    </Wrap>
  );
}

function AdminSources() {
  const { toast } = useApp();
  const [edit, setEdit] = useState<any>(null);
  return (
    <Wrap url="/api/admin/sources" live={["source"]}>
      {(d, reload) => (
        <>
          {edit && (
            <form
              className="panel"
              style={{ marginBottom: 16 }}
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await api.patch(`/api/admin/sources/${edit.id}`, {
                    name: edit.name, feedUrl: edit.feed_url, category: edit.category, kind: edit.kind, region: edit.region || null,
                    intervalMinutes: Number(edit.interval_minutes), priority: Number(edit.priority), adminDisabled: Boolean(edit.admin_disabled), defaultEnabled: Boolean(edit.default_enabled),
                  });
                  toast("Source updated");
                  setEdit(null);
                  reload();
                } catch (err: any) {
                  toast(err.message, "error");
                }
              }}
            >
              <h2>Configure {edit.name}</h2>
              <div className="grid-3">
                {[["name", "Name"], ["feed_url", "Feed URL"], ["category", "Category"], ["kind", "Kind"], ["region", "Region code"], ["interval_minutes", "Interval (min)"], ["priority", "Editorial priority (-5..5)"]].map(([k, l]) => (
                  <div className="field" key={k}>
                    <label htmlFor={`as-${k}`}>{l}</label>
                    <input id={`as-${k}`} type="text" value={edit[k] ?? ""} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} />
                  </div>
                ))}
              </div>
              <label className="check" style={{ marginRight: 16 }}><input type="checkbox" checked={Boolean(edit.admin_disabled)} onChange={(e) => setEdit({ ...edit, admin_disabled: e.target.checked })} /> Disabled for everyone</label>
              <label className="check"><input type="checkbox" checked={Boolean(edit.default_enabled)} onChange={(e) => setEdit({ ...edit, default_enabled: e.target.checked })} /> Enabled by default for new readers</label>
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button className="btn primary">Save</button>
                <button type="button" className="btn ghost" onClick={() => setEdit(null)}>Cancel</button>
              </div>
            </form>
          )}
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Source</th><th>Status</th><th>Last success</th><th>Next fetch</th><th>Failures</th><th>Articles</th><th>Readers</th><th /></tr></thead>
              <tbody>
                {d.sources.map((s: any) => (
                  <tr key={s.id}>
                    <td><strong>{s.name}</strong><div className="mono meta">{s.feed_url}</div>{s.last_error && <div style={{ color: "var(--error)", fontSize: "0.8rem" }}>{s.last_error}</div>}</td>
                    <td><SourceStatus status={s.admin_disabled ? "disabled" : s.status} /></td>
                    <td>{s.last_success_at ? ago(s.last_success_at) : "never"}</td>
                    <td>{s.next_fetch_at ? fmtDateTime(s.next_fetch_at) : "due"}</td>
                    <td>{s.consecutive_failures}</td>
                    <td>{s.article_count}</td>
                    <td>{s.readers_enabled}</td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <button className="btn sm" onClick={async () => { const r = await api.post(`/api/admin/sources/${s.id}/retry`); toast(r.queued ? "Retry queued" : "Already running"); reload(); }}>Retry</button>{" "}
                      <button className="btn sm ghost" onClick={() => setEdit({ ...s })}>Configure</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Wrap>
  );
}

function Jobs() {
  const [status, setStatus] = useState("");
  return (
    <>
      <div className="toolbar">
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All jobs</option>
          <option value="ok">Succeeded</option>
          <option value="not_modified">Not modified</option>
          <option value="error">Failed</option>
          <option value="running">Running</option>
        </select>
      </div>
      <Wrap url={`/api/admin/jobs${qs({ status })}`} live={["source"]}>
        {(d) => (
          <>
            <p className="meta">Running: {d.queue.running.length} · queued: {d.queue.queued.length}</p>
            {!d.jobs.length ? <Empty title="No jobs yet" /> : (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Started</th><th>Source</th><th>Trigger</th><th>Status</th><th>HTTP</th><th>Found</th><th>New</th><th>Updated</th><th>Dupes</th><th>Invalid</th><th>Time</th><th>Error</th></tr></thead>
                  <tbody>
                    {d.jobs.map((j: any) => (
                      <tr key={j.id}>
                        <td>{fmtDateTime(j.started_at)}</td><td>{j.source_name}</td><td>{j.trigger}</td><td>{j.status}</td><td>{j.http_status ?? ""}</td>
                        <td>{j.items_found ?? ""}</td><td>{j.items_new ?? ""}</td><td>{j.items_updated ?? ""}</td><td>{j.items_duplicate ?? ""}</td><td>{j.items_invalid ?? ""}</td>
                        <td>{j.duration_ms != null ? `${j.duration_ms} ms` : ""}</td><td style={{ color: "var(--error)" }}>{j.error}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Wrap>
    </>
  );
}

function Duplicates() {
  return (
    <Wrap url="/api/admin/duplicates">
      {(d) => (
        <>
          <p className="meta">By method: {d.byMethod.map((m: any) => `${m.method} ${m.n}`).join(" · ") || "none"}</p>
          {!d.items.length ? <Empty title="No duplicates detected yet" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>When</th><th>Source</th><th>Candidate</th><th>Method</th><th>Matched article</th></tr></thead>
                <tbody>
                  {d.items.map((x: any) => (
                    <tr key={x.id}>
                      <td>{fmtDateTime(x.at)}</td><td>{x.source_name}</td><td>{x.candidate_title}<div className="mono meta">{x.candidate_url}</div></td><td>{x.method} · {x.action}</td>
                      <td>{x.matched_article_id ? <Link to={`/article/${x.matched_article_id}`}>{x.matched_headline ?? `#${x.matched_article_id}`}</Link> : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Wrap>
  );
}

function Clusters() {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const { toast } = useApp();
  return (
    <>
      <form className="toolbar" onSubmit={(e) => { e.preventDefault(); setQuery(q); }}>
        <input type="search" aria-label="Filter by headline" placeholder="Filter by headline" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn sm">Filter</button>
      </form>
      <Wrap url={`/api/admin/clusters${qs({ q: query })}`}>
        {(d, reload) => (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Story</th><th>Category</th><th>Status</th><th>Importance</th><th>Articles / sources</th><th>Summary</th><th /></tr></thead>
              <tbody>
                {d.clusters.map((c: any) => (
                  <Fragment key={c.id}>
                    <tr>
                      <td><Link to={`/story/${c.id}`}>{c.headline}</Link><div className="meta">#{c.id} · first seen {ago(c.first_seen_at)}</div></td>
                      <td>{c.category}</td>
                      <td>{c.is_breaking ? "breaking · " : ""}{c.status}</td>
                      <td title={c.importance_reasons.map((r: any) => `${r.label} (${r.points})`).join("\n")}>{c.importance}</td>
                      <td>{c.article_count} / {c.source_count}</td>
                      <td>{c.summary_error ? <span style={{ color: "var(--error)" }}>error</span> : c.has_summary ? (c.needs_resummary ? "stale" : "ok") : "none"}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <button className="btn sm ghost" onClick={() => setOpen(open === c.id ? null : c.id)}>Inspect</button>
                        <button className="btn sm ghost" onClick={async () => { const r = await api.post(`/api/admin/clusters/${c.id}/recalculate`); toast(`Recalculated; ${r.clusters.length} stories affected`); reload(); }}>Recluster</button>
                        <button className="btn sm ghost" onClick={async () => { const r = await api.post(`/api/admin/clusters/${c.id}/resummarize`); toast(`Summary: ${r.status}`); reload(); }}>Resummarize</button>
                      </td>
                    </tr>
                    {open === c.id && (
                      <tr key={`${c.id}-d`}><td colSpan={7}><ClusterDetail id={c.id} /></td></tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Wrap>
    </>
  );
}

function ClusterDetail({ id }: { id: number }) {
  const { toast } = useApp();
  return (
    <Wrap url={`/api/admin/clusters/${id}`}>
      {(d) => (
        <div className="grid-2">
          <div>
            <div className="label">Articles</div>
            <ul className="facts">
              {d.articles.map((a: any) => (
                <li key={a.id}>
                  {a.source_name}: {a.headline} <span className="meta" style={{ display: "inline" }}>{a.category} · {a.article_type} · simhash {a.simhash}</span>{" "}
                  <button className="btn sm ghost" onClick={async () => { const r = await api.post(`/api/admin/articles/${a.id}/reprocess`); toast(`Reprocessed: ${r.classification.category}, story #${r.assignment.clusterId}`); }}>Reprocess</button>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="label">Events</div>
            <ul className="facts">{d.events.map((e: any) => <li key={e.id}>{fmtDateTime(e.at)} {e.kind}{e.significant ? " (significant)" : ""}: {e.text}</li>)}</ul>
            {d.aiJobs.length > 0 && <><div className="label">AI jobs</div><ul className="facts">{d.aiJobs.map((j: any) => <li key={j.id}>{fmtDateTime(j.started_at)} {j.status} {j.error ?? ""}</li>)}</ul></>}
          </div>
        </div>
      )}
    </Wrap>
  );
}

function AiJobs() {
  return (
    <Wrap url="/api/admin/ai-jobs">
      {(d) => (
        <>
          {!d.jobs.length ? <Empty title="No AI jobs have run">AI jobs run when ANTHROPIC_API_KEY is set on the server.</Empty> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Started</th><th>Kind</th><th>Target</th><th>Model</th><th>Status</th><th>Tokens in/out</th><th>Time</th><th>Error</th></tr></thead>
                <tbody>
                  {d.jobs.map((j: any) => (
                    <tr key={j.id}>
                      <td>{fmtDateTime(j.started_at)}</td><td>{j.kind}</td><td>{j.target_id}</td><td>{j.model}</td><td>{j.status}</td>
                      <td>{j.input_tokens ?? ""}/{j.output_tokens ?? ""}</td><td>{j.finished_at ? `${Date.parse(j.finished_at) - Date.parse(j.started_at)} ms` : ""}</td><td style={{ color: "var(--error)" }}>{j.error}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {d.failedArticles.length > 0 && (
            <div className="panel">
              <h2>Articles with processing errors</h2>
              <ul className="facts">{d.failedArticles.map((a: any) => <li key={a.id}><Link to={`/article/${a.id}`}>{a.headline}</Link>: {a.processing_error}</li>)}</ul>
            </div>
          )}
        </>
      )}
    </Wrap>
  );
}

function Briefings() {
  const { toast } = useApp();
  return (
    <Wrap url="/api/admin/briefings">
      {(d, reload) =>
        !d.briefings.length ? <Empty title="No briefings generated yet" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Generated</th><th>Reader</th><th>Edition</th><th>Revision</th><th>Stories</th><th>AI</th><th /></tr></thead>
              <tbody>
                {d.briefings.map((b: any) => (
                  <tr key={b.id}>
                    <td>{fmtDateTime(b.generated_at)}</td><td>{b.email}</td><td>{b.edition_date} {b.edition} ({b.status})</td>
                    <td>{b.revision}{b.revision_reason ? ` · ${b.revision_reason}` : ""}</td><td>{b.stories}</td><td>{b.ai_status}{b.ai_model ? ` · ${b.ai_model}` : ""}</td>
                    <td><button className="btn sm ghost" onClick={async () => { const r = await api.post(`/api/admin/briefings/${b.id}/regenerate`); toast(`Corrected revision #${r.briefingId} created`); reload(); }}>Regenerate</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      }
    </Wrap>
  );
}

function Notifications() {
  return (
    <Wrap url="/api/admin/notifications">
      {(d) => (
        <>
          <p className="meta">Deliveries: {d.summary.map((s: any) => `${s.channel} ${s.status} ${s.n}`).join(" · ") || "none"}</p>
          {!d.failures.length ? <Empty title="No delivery failures" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>When</th><th>User</th><th>Kind</th><th>Title</th><th>Channel</th><th>Status</th><th>Error</th></tr></thead>
                <tbody>
                  {d.failures.map((f: any) => (
                    <tr key={f.id}><td>{fmtDateTime(f.at)}</td><td>{f.user_id}</td><td>{f.kind}</td><td>{f.title}</td><td>{f.channel}</td><td>{f.status}</td><td>{f.error}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Wrap>
  );
}

function Ranking() {
  const { toast } = useApp();
  const [w, setW] = useState<any>(null);
  return (
    <Wrap url="/api/admin/ranking-weights">
      {(d, reload) => {
        const cur = w ?? d.weights;
        return (
          <div className="panel" style={{ maxWidth: 640 }}>
            <h2>Ranking weights</h2>
            <p className="meta">Maximum points each signal can contribute to a story's importance score. Changes re-rank stories from the last four days.</p>
            {Object.keys(d.defaults).map((k) => (
              <div className="field" key={k} style={{ display: "grid", gridTemplateColumns: "160px 1fr 60px", alignItems: "center", gap: 10 }}>
                <label htmlFor={`w-${k}`}>{k}</label>
                <input id={`w-${k}`} type="range" min={-50} max={60} value={cur[k]} onChange={(e) => setW({ ...cur, [k]: Number(e.target.value) })} />
                <span className="meta">{cur[k]} <span title="default">({d.defaults[k]})</span></span>
              </div>
            ))}
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn primary" disabled={!w} onClick={async () => { const r = await api.put("/api/admin/ranking-weights", w); toast(`Saved; ${r.reranked} stories re-ranked`); setW(null); reload(); }}>Save weights</button>
              <button className="btn ghost" onClick={() => setW({ ...d.defaults })}>Restore defaults</button>
            </div>
          </div>
        );
      }}
    </Wrap>
  );
}

function Diagnose() {
  const [q, setQ] = useState("");
  const [userId, setUserId] = useState("");
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="panel" style={{ maxWidth: 800 }}>
      <h2>Why is a story (not) appearing?</h2>
      <p className="meta">Paste an article URL or headline text. The pipeline is walked from collection to a reader's edition.</p>
      <form
        className="toolbar"
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          try {
            setRes(await api.get(`/api/admin/diagnose${qs({ q, userId })}`));
          } catch (x: any) {
            setErr(x.message);
          }
        }}
      >
        <input type="text" className="grow" aria-label="URL or headline" placeholder="https://… or headline words" value={q} onChange={(e) => setQ(e.target.value)} required />
        <input type="number" aria-label="Reader id (optional)" placeholder="Reader id" value={userId} onChange={(e) => setUserId(e.target.value)} style={{ width: 110 }} />
        <button className="btn primary">Diagnose</button>
      </form>
      {err && <ErrorState error={err} />}
      {res && (
        <ol className="timeline">
          {res.steps.map((s: any, i: number) => (
            <li key={i} className={s.ok ? "sig" : "correction"}>
              <div style={{ fontWeight: 600 }}>{s.stage}: {s.ok ? "OK" : "Problem"}</div>
              <div>{s.detail}</div>
            </li>
          ))}
        </ol>
      )}
      {res?.clusterId && <Link to={`/story/${res.clusterId}`}>Open story</Link>}
    </div>
  );
}

function Logs() {
  const [level, setLevel] = useState("");
  return (
    <>
      <div className="toolbar">
        <select aria-label="Level" value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="">All levels</option>
          <option value="error">Errors</option>
          <option value="warn">Warnings</option>
          <option value="info">Info</option>
        </select>
      </div>
      <Wrap url={`/api/admin/logs${qs({ level })}`}>
        {(d) =>
          !d.logs.length ? <Empty title="No log entries" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>When</th><th>Level</th><th>Area</th><th>Message</th><th>Data</th></tr></thead>
                <tbody>
                  {d.logs.map((l: any) => (
                    <tr key={l.id}><td>{fmtDateTime(l.at)}</td><td>{l.level}</td><td>{l.area}</td><td>{l.message}</td><td className="mono">{l.data ? JSON.stringify(l.data) : ""}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Wrap>
    </>
  );
}

function Users() {
  const { toast, session } = useApp();
  return (
    <Wrap url="/api/admin/users">
      {(d, reload) => (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Id</th><th>Email</th><th>Name</th><th>Time zone</th><th>Created</th><th>Admin</th></tr></thead>
            <tbody>
              {d.users.map((u: any) => (
                <tr key={u.id}>
                  <td>{u.id}</td><td>{u.email}</td><td>{u.display_name}</td><td>{u.timezone}</td><td>{fmtDateTime(u.created_at)}</td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Administrator: ${u.email}`}
                      checked={Boolean(u.is_admin)}
                      disabled={u.id === session?.user?.id}
                      onChange={async (e) => {
                        try {
                          await api.patch(`/api/admin/users/${u.id}`, { isAdmin: e.target.checked });
                          reload();
                        } catch (x: any) {
                          toast(x.message, "error");
                        }
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="meta" style={{ padding: "0 12px" }}>New readers can sign up when the server runs with ALLOW_SIGNUP=1.</p>
        </div>
      )}
    </Wrap>
  );
}
