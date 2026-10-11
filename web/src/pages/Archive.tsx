import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { useApp, useLoad } from "../lib/app";
import { ago, fmtDate, fmtDateTime } from "../lib/format";
import { ConfigNotice, Empty, ErrorState, Loading, StoryCard } from "../components/ui";

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function Archive() {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get("tab") ?? "day";
  const date = sp.get("date") ?? todayStr();
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(sp);
    n.set(k, v);
    setSp(n);
  };
  return (
    <div className="page">
      <h1 className="hl hl-l">Archive</h1>
      <div className="tabs" role="tablist">
        {[["day", "By date"], ["editions", "All briefings"], ["weekly", "Weekly recap"]].map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => set("tab", k)}>{l}</button>
        ))}
      </div>
      {tab === "day" && <Day date={date} setDate={(d) => set("date", d)} />}
      {tab === "editions" && <Editions />}
      {tab === "weekly" && <Weekly />}
    </div>
  );
}

function Day({ date, setDate }: { date: string; setDate: (d: string) => void }) {
  const { data, error, loading, reload } = useLoad<any>(`/api/archive?date=${date}`);
  const shift = (n: number) => {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    setDate(d.toISOString().slice(0, 10));
  };
  return (
    <>
      <div className="toolbar">
        <button className="btn sm" onClick={() => shift(-1)} aria-label="Previous day">←</button>
        <label className="sr-only" htmlFor="arch-date">Date</label>
        <input id="arch-date" type="date" value={date} max={todayStr()} onChange={(e) => e.target.value && setDate(e.target.value)} />
        <button className="btn sm" onClick={() => shift(1)} disabled={date >= todayStr()} aria-label="Next day">→</button>
        <span className="meta">{fmtDate(`${date}T12:00:00Z`, { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}</span>
      </div>
      {loading && !data && <Loading lines={6} />}
      {error && <ErrorState error={error} retry={() => reload()} />}
      {data && (
        <div className="two-col">
          <div style={{ minWidth: 0 }}>
            <div className="section-title"><h2>Stories published this day</h2></div>
            {!data.stories.length ? (
              <Empty title="No stories collected for this date">The archive starts when your sources were first collected.</Empty>
            ) : (
              <div className="list">{data.stories.map((s: any) => <StoryCard key={s.id} s={s} variant="row" showImage={false} />)}</div>
            )}
          </div>
          <aside className="rail">
            <div className="rail-box">
              <h2>Briefings</h2>
              {!data.briefings.length ? <p className="meta">No briefings for this date.</p> : (
                <ul>
                  {data.briefings.map((b: any) => (
                    <li key={b.id}>
                      <Link to={`/quick-reads/${b.id}`}>{b.edition === "morning" ? "Morning" : "Evening"} edition{b.revision > 1 ? `, revision ${b.revision}` : ""}</Link>
                      <div className="meta"><span>{fmtDateTime(b.generated_at)}</span><span>{b.status}</span>{b.revision_reason && <span>{b.revision_reason}</span>}</div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {data.pastEvents.length > 0 && (
              <div className="rail-box">
                <h2>Scheduled that day</h2>
                <ul>{data.pastEvents.map((e: any) => <li key={e.id}>{e.title}</li>)}</ul>
              </div>
            )}
            {data.days.length > 0 && (
              <div className="rail-box">
                <h2>Days with coverage</h2>
                <div className="chips">
                  {data.days.slice(0, 30).map((d: any) => (
                    <button key={d.day} className={`chip ${d.day === date ? "on" : ""}`} onClick={() => setDate(d.day)} title={`${d.n} articles`}>
                      {fmtDate(`${d.day}T12:00:00Z`, { month: "short", day: "numeric", timeZone: "UTC" })}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </aside>
        </div>
      )}
    </>
  );
}

function Editions() {
  const { data, error, loading } = useLoad<any>("/api/briefings");
  const { toast } = useApp();
  if (loading && !data) return <Loading lines={6} />;
  if (error) return <ErrorState error={error} />;
  if (!data.editions.length) return <Empty title="No briefings yet" />;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr><th>Edition</th><th>Generated</th><th>Stories</th><th>Status</th><th>Revisions</th><th /></tr>
        </thead>
        <tbody>
          {data.editions.map((e: any) => (
            <tr key={`${e.editionDate}-${e.edition}`}>
              <td><Link to={`/quick-reads/${e.latest.id}`}>{fmtDate(`${e.editionDate}T12:00:00Z`, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}, {e.edition}</Link></td>
              <td>{fmtDateTime(e.latest.generated_at)}</td>
              <td>{e.latest.stories}</td>
              <td>{e.latest.status}{e.latest.ai_status !== "generated" ? ` · ${e.latest.ai_status === "not_configured" ? "no AI prose" : e.latest.ai_status}` : ""}</td>
              <td>
                {e.revisions.length > 1
                  ? e.revisions.map((r: any) => <Link key={r.id} to={`/quick-reads/${r.id}`} style={{ marginRight: 8 }}>r{r.revision}</Link>)
                  : "1"}
              </td>
              <td>
                <button
                  className="btn sm ghost"
                  title="Creates a corrected revision using the same stories; the original stays available."
                  onClick={async () => {
                    try {
                      const r = await api.post(`/api/briefing/${e.latest.id}/regenerate`);
                      toast(`Corrected revision created (#${r.briefingId})`);
                    } catch (err: any) {
                      toast(err.message, "error");
                    }
                  }}
                >
                  Regenerate
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Weekly() {
  const [refreshKey, setRefreshKey] = useState(0);
  const { data, error, loading, reload } = useLoad<any>(`/api/weekly${refreshKey ? "?refresh=1" : ""}`, { deps: [refreshKey] });
  if (loading && !data) return <Loading lines={8} />;
  if (error) return <ErrorState error={error} retry={() => reload()} />;
  if (!data) return null;
  const byId = new Map(data.stories.map((s: any) => [s.id, s]));
  const link = (id: number) => {
    const s: any = byId.get(id);
    return s ? <Link key={id} to={`/story/${id}`} className="cite" style={{ marginRight: 6 }}>{s.headline.slice(0, 50)}</Link> : null;
  };
  return (
    <div className="reader" style={{ margin: 0, maxWidth: 900 }}>
      <div className="toolbar">
        <h2 className="hl hl-m" style={{ margin: 0 }}>Week {data.week.split("-W")[1]}, {data.week.split("-W")[0]}</h2>
        <span className="grow" />
        <span className="meta">Compiled {ago(data.generatedAt)}</span>
        <button className="btn sm" onClick={() => setRefreshKey(refreshKey + 1)}>Recompile</button>
      </div>
      {data.aiStatus !== "configured" && (
        <ConfigNotice title="Written recap needs an AI key">The themes and narrative are written by an AI model, which is not configured. The week's top stories are listed below.</ConfigNotice>
      )}
      {data.aiError && <div className="notice error"><div><strong>The written recap failed</strong>{data.aiError}</div></div>}
      {data.ai && (
        <>
          <p className="big-picture">{data.ai.overview}</p>
          {data.ai.themes.map((t: any, i: number) => (
            <div key={i} className="callout" style={{ margin: "12px 0" }}>
              <h3>{t.theme}</h3>
              <p style={{ margin: "0 0 6px" }}>{t.explanation}</p>
              <div>{t.cluster_ids.map(link)}</div>
            </div>
          ))}
          <div className="grid-2">
            <div>
              <div className="label">Resolved</div>
              <ul className="facts">{data.ai.resolved.map((r: any, i: number) => <li key={i}>{r.text} {link(r.cluster_id)}</li>)}</ul>
            </div>
            <div>
              <div className="label">Still open</div>
              <ul className="facts">{data.ai.outstanding.map((r: any, i: number) => <li key={i}>{r.text} {link(r.cluster_id)}</li>)}</ul>
            </div>
          </div>
        </>
      )}
      <div className="section-title" style={{ marginTop: 20 }}><h2>Top stories of the week</h2></div>
      {!data.stories.length ? <Empty title="No stories this week yet" /> : (
        <ol className="facts">
          {data.stories.map((s: any) => (
            <li key={s.id}>
              <Link to={`/story/${s.id}`} style={{ fontWeight: 600 }}>{s.headline}</Link>{" "}
              <span className="meta" style={{ display: "inline" }}>{s.category} · {s.sourceCount} sources · {s.status}</span>
            </li>
          ))}
        </ol>
      )}
      {data.categoryCounts.length > 0 && (
        <p className="meta">Stories by section: {data.categoryCounts.map((c: any) => `${c.category} ${c.stories}`).join(" · ")}</p>
      )}
    </div>
  );
}
