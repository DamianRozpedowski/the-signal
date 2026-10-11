import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { useApp, useLoad } from "../lib/app";
import { ago, fmtDate, fmtDateTime, fmtTime, shortSource, until } from "../lib/format";
import { ConfigNotice, Empty, ErrorState, ExternalLink, Loading, SaveButton } from "../components/ui";
import { STATIC } from "../lib/static";

type Mode = 2 | 5 | 10;
const MODE_KEY: Record<Mode, "two" | "five" | "ten"> = { 2: "two", 5: "five", 10: "ten" };

export function QuickReads() {
  const { id } = useParams();
  const { prefs, toast } = useApp();
  const url = id ? `/api/briefing/${id}` : "/api/briefing/current";
  const { data, error, loading, reload, setData } = useLoad<any>(url, { liveOn: id ? [] : ["briefing"] });
  const [mode, setMode] = useState<Mode>((prefs?.briefing?.defaultLength as Mode) ?? 5);
  const [busy, setBusy] = useState(false);
  const [revisions, setRevisions] = useState<any[] | null>(null);
  const b = data?.briefing;

  useEffect(() => {
    if (!b) return;
    if (data.revisions) setRevisions(data.revisions);
    else api.get(`/api/briefing/${b.id}`).then((r) => setRevisions(r.revisions)).catch(() => setRevisions(null));
  }, [b?.id]);

  const refresh = async () => {
    setBusy(true);
    try {
      const r = await api.post("/api/briefing/refresh");
      setData({ ...data, briefing: r.briefing });
      toast(r.result?.regenerated ? "Briefing updated with the latest stories" : "Briefing is already current");
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  };

  if (loading && !data) return <div className="page reader"><Loading lines={10} /></div>;
  if (error) return <div className="page"><ErrorState error={error} retry={reload} /></div>;
  if (!b) {
    return (
      <div className="page reader">
        <h1 className="hl hl-l">Quick Reads</h1>
        <Empty title="No briefing yet">
          A briefing is generated once your enabled sources have produced stories. <Link to="/sources">Check your sources</Link>.
        </Empty>
      </div>
    );
  }
  const c = b.content;
  const ids: number[] = c.modes?.[MODE_KEY[mode]] ?? [];
  const stories = ids.map((cid) => c.stories.find((s: any) => s.clusterId === cid)).filter(Boolean);
  const isCurrent = !id;
  const latestRevision = revisions ? Math.max(...revisions.map((r) => r.revision)) : b.revision;

  return (
    <div className="page reader">
      <header className="brief-head">
        <div>
          <div className="kicker">Quick Reads · {c.editionLabel}</div>
          <h1 className="hl hl-l" style={{ margin: "4px 0 0" }}>{fmtDate(b.editionDate + "T12:00:00Z", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" })}</h1>
          <div className="brief-meta">
            <span>Generated {fmtDateTime(b.generatedAt)}</span>
            {b.dataRefreshedAt && <span>News data as of {fmtTime(b.dataRefreshedAt)}</span>}
            <span>Covers {fmtDateTime(c.window.start)} – {fmtDateTime(c.window.end)}</span>
            <span>{b.status === "final" ? "Final edition" : "Live edition, updates as news changes"}</span>
            {b.revision > 1 && <span>Revision {b.revision}{b.revisionReason ? ` (${b.revisionReason})` : ""}</span>}
            {b.revision < latestRevision && <span style={{ color: "var(--warn)" }}>A newer revision of this edition exists</span>}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end" }}>
          <div className="seg" role="group" aria-label="Reading length">
            {([2, 5, 10] as Mode[]).map((m) => (
              <button key={m} className={mode === m ? "on" : ""} aria-pressed={mode === m} onClick={() => setMode(m)}>
                {m} min
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {isCurrent && !STATIC && (
              <button className="btn sm" onClick={refresh} disabled={busy}>
                {busy ? "Updating…" : "Update briefing"}
              </button>
            )}
            <SaveButton type="briefing" id={b.id} initial={false} />
          </div>
        </div>
      </header>

      <section aria-labelledby="bp">
        <h2 id="bp" className="kicker">The big picture</h2>
        {c.bigPicture.status === "generated" ? (
          <>
            <p className="big-picture">{c.bigPicture.text}</p>
            {c.bigPicture.themes?.length > 0 && (
              <div className="chips" style={{ margin: "8px 0" }}>
                {c.bigPicture.themes.map((t: string) => (
                  <span key={t} className="badge neutral">{t}</span>
                ))}
              </div>
            )}
            {c.bigPicture.changeNote && <p className="meta">Since the last briefing: {c.bigPicture.changeNote}</p>}
          </>
        ) : c.bigPicture.status === "extracted" ? (
          <>
            {/* Headlines only: each story's lead sentence is shown once, in its own entry below. */}
            <ol className="at-a-glance">
              {c.bigPicture.items.map((it: any) => (
                <li key={it.clusterId}>
                  <a href={`#brief-${it.clusterId}`}>{it.headline}</a>
                </li>
              ))}
            </ol>
            {c.bigPicture.themes?.length > 0 && (
              <div className="chips" style={{ margin: "8px 0" }}>
                {c.bigPicture.themes.map((t: string) => (
                  <span key={t} className="badge neutral">{t}</span>
                ))}
              </div>
            )}
            <p className="meta">Summaries below are sentences quoted from each story's coverage, picked automatically, not written by AI.</p>
          </>
        ) : c.bigPicture.status === "not_configured" ? (
          <ConfigNotice title="Written summaries need an AI key">
            The overview and story summaries are written by an AI model, which is not configured on this server (set ANTHROPIC_API_KEY). Below are the
            day's most important stories in ranked order with each publisher's own description.
          </ConfigNotice>
        ) : (
          <div className="notice error" role="status">
            <div>
              <strong>The written overview could not be generated</strong>
              {c.bigPicture.error ?? "The AI service returned an error."} Story rankings and sources below are still current.
            </div>
          </div>
        )}
        <p className="meta" style={{ marginTop: 10 }}>
          {stories.length} {stories.length === 1 ? "story" : "stories"} · about {c.readingMinutes?.[MODE_KEY[mode]] ?? mode} minute{(c.readingMinutes?.[MODE_KEY[mode]] ?? mode) === 1 ? "" : "s"} to read
        </p>
      </section>

      <section aria-label="Essential stories">
        {!stories.length && <Empty title="No stories in this window">Your sources have not produced stories for this edition yet.</Empty>}
        {stories.map((s: any, i: number) => (
          <BriefStory key={s.clusterId} s={s} n={i + 1} mode={mode} />
        ))}
      </section>

      <div className="grid-2" style={{ marginTop: 28 }}>
        <Overnight o={c.overnight} />
        <Changes ch={c.changes} />
      </div>

      <Watch items={c.watch} onAdded={reload} />

      {c.coverageNotes?.length > 0 && (
        <section className="panel" style={{ marginTop: 20 }} aria-labelledby="cov">
          <h2 id="cov">About this briefing's coverage</h2>
          <ul className="facts">
            {c.coverageNotes.map((n: any, i: number) => (
              <li key={i}>{n.text}</li>
            ))}
          </ul>
        </section>
      )}

      {revisions && revisions.length > 1 && (
        <section className="panel" style={{ marginTop: 20 }} aria-labelledby="revs">
          <h2 id="revs">Revisions of this edition</h2>
          <p className="meta">Earlier versions are kept unchanged so you can see how the briefing evolved.</p>
          <ul className="facts">
            {revisions.map((r) => (
              <li key={r.id}>
                {r.id === b.id ? <strong>Revision {r.revision}</strong> : <Link to={`/quick-reads/${r.id}`}>Revision {r.revision}</Link>} · {fmtDateTime(r.generated_at)}
                {r.revision_reason ? ` · ${r.revision_reason}` : ""} · {r.status}
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="meta" style={{ marginTop: 20 }}>
        <Link to="/archive">Browse past editions →</Link>
      </p>
    </div>
  );
}

/** Quoted sentences, each followed by a link to the article it came from. */
function Quotes({ qs, s }: { qs: any[]; s: any }) {
  return (
    <>
      {qs.map((q: any, i: number) => {
        const src = s.sources.find((x: any) => x.articleId === q.article_ids[0]);
        return (
          <span key={i}>
            {q.text} {src && <Link className="src-tag" to={`/article/${src.articleId}`} title={src.sourceName}>{shortSource(src.sourceName)}</Link>}{" "}
          </span>
        );
      })}
    </>
  );
}

function BriefStory({ s, n, mode }: { s: any; n: number; mode: Mode }) {
  const ai = s.ai;
  const desc = s.publisherDescription;
  const x = !ai && s.extract;
  if (x) {
    return (
      <article className="brief-story" id={`brief-${s.clusterId}`}>
        <div className="num" aria-hidden="true">{n}</div>
        <div>
          <div className="badges">
            <span className="kicker">{s.categoryLabel}</span>
            {s.isBreaking && <span className="badge breaking">Breaking</span>}
            {s.status === "developing" && <span className="badge developing">Developing</span>}
          </div>
          <h3>
            <Link to={`/story/${s.clusterId}`}>{s.headline}</Link>
          </h3>
          {mode === 2 ? (
            <p className="dek"><Quotes qs={x.inBrief} s={s} /></p>
          ) : (
            <dl>
              <dt>What happened</dt>
              <dd><Quotes qs={x.whatHappened} s={s} /></dd>
              {mode === 10 && x.keyFacts.length > 0 && (
                <>
                  <dt>Figures reported</dt>
                  <dd>
                    <ul className="facts">
                      {x.keyFacts.map((f: any, i: number) => <li key={i}><Quotes qs={[f]} s={s} /></li>)}
                    </ul>
                  </dd>
                </>
              )}
              {mode === 10 && x.more.length > 0 && (
                <>
                  <dt>More detail</dt>
                  <dd><Quotes qs={x.more} s={s} /></dd>
                </>
              )}
              {mode === 10 && x.quotes.length > 0 && (
                <>
                  <dt>What people said</dt>
                  <dd>
                    <ul className="facts">
                      {x.quotes.map((f: any, i: number) => <li key={i}><Quotes qs={[f]} s={s} /></li>)}
                    </ul>
                  </dd>
                </>
              )}
            </dl>
          )}
          <div className="brief-sources">
            <span>Updated {ago(s.lastUpdateAt)}</span>
            {s.sources.slice(0, mode === 2 ? 2 : mode === 5 ? 4 : 8).map((src: any) => (
              <ExternalLink key={src.articleId} href={src.url}>{src.sourceName}</ExternalLink>
            ))}
            {s.sources.length > (mode === 2 ? 2 : mode === 5 ? 4 : 8) && <Link to={`/story/${s.clusterId}`}>+{s.sources.length - (mode === 2 ? 2 : mode === 5 ? 4 : 8)} more</Link>}
          </div>
        </div>
      </article>
    );
  }
  return (
    <article className="brief-story">
      <div className="num" aria-hidden="true">{n}</div>
      <div>
        <div className="badges">
          <span className="kicker">{s.categoryLabel}</span>
          {s.isBreaking && <span className="badge breaking">Breaking</span>}
          {s.status === "developing" && <span className="badge developing">Developing</span>}
        </div>
        <h3>
          <Link to={`/story/${s.clusterId}`}>{s.headline}</Link>
        </h3>
        {mode === 2 ? (
          <p className="dek">{ai?.twoMin || (desc ? `${desc.text} (${desc.sourceName})` : "")}</p>
        ) : (
          <dl>
            <dt>What happened</dt>
            <dd>{ai?.whatHappened || (desc ? <>{desc.text} <span className="meta">— description from {desc.sourceName}</span></> : <span className="meta">No description available; open the story for sources.</span>)}</dd>
            {ai?.whyItMatters && (
              <>
                <dt>Why it matters</dt>
                <dd>{ai.whyItMatters}</dd>
              </>
            )}
            {mode === 10 && ai?.keyFacts?.length > 0 && (
              <>
                <dt>Key facts</dt>
                <dd>
                  <ul className="facts">
                    {ai.keyFacts.map((f: any, i: number) => (
                      <li key={i}>{f.text}</li>
                    ))}
                  </ul>
                </dd>
              </>
            )}
            {mode === 10 && ai?.background && (
              <>
                <dt>Background</dt>
                <dd>{ai.background}</dd>
              </>
            )}
            {mode === 10 && ai?.disagreements?.length > 0 && (
              <>
                <dt>Where sources differ</dt>
                <dd>
                  <ul className="facts">
                    {ai.disagreements.map((d: string, i: number) => (
                      <li key={i}>{d}</li>
                    ))}
                  </ul>
                </dd>
              </>
            )}
            {mode === 10 && ai?.whatsNext && (
              <>
                <dt>What's next</dt>
                <dd>{ai.whatsNext}</dd>
              </>
            )}
          </dl>
        )}
        <div className="brief-sources">
          <span>Updated {ago(s.lastUpdateAt)}</span>
          {s.sources.slice(0, mode === 2 ? 2 : mode === 5 ? 4 : 8).map((src: any) => (
            <ExternalLink key={src.articleId} href={src.url}>{src.sourceName}</ExternalLink>
          ))}
          {s.sources.length > (mode === 2 ? 2 : mode === 5 ? 4 : 8) && <Link to={`/story/${s.clusterId}`}>+{s.sources.length - (mode === 2 ? 2 : mode === 5 ? 4 : 8)} more</Link>}
        </div>
      </div>
    </article>
  );
}

function Overnight({ o }: { o: any }) {
  return (
    <section className="callout" aria-labelledby="overnight">
      <h3 id="overnight">{o.label || "Overnight"}</h3>
      <p className="meta" style={{ marginTop: 0 }}>
        {fmtDateTime(o.from)} – {fmtDateTime(o.to)}
      </p>
      {!o.items.length ? (
        <p className="meta">No significant developments from your sources in this period.</p>
      ) : (
        <ul className="timeline">
          {o.items.map((it: any, i: number) => (
            <li key={i} className={it.isNew ? "sig" : ""}>
              <div className="when">{fmtTime(it.at)} · {it.isNew ? "New story" : "Update"}</div>
              <Link to={`/story/${it.clusterId}`} style={{ fontWeight: 600 }}>{it.headline}</Link>
              {it.text && it.text !== it.headline && <div className="meta">{it.text}</div>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Changes({ ch }: { ch: any }) {
  const empty = !ch.newStories.length && !ch.significantUpdates.length && !ch.corrections.length && !ch.lessRelevant.length;
  return (
    <section className="callout" aria-labelledby="changed">
      <h3 id="changed">What changed</h3>
      <p className="meta" style={{ marginTop: 0 }}>{ch.previousGeneratedAt ? `Since the briefing at ${fmtDateTime(ch.previousGeneratedAt)}` : "This is the first briefing; nothing to compare yet."}</p>
      {ch.previousGeneratedAt && empty && <p className="meta">No material changes.</p>}
      {ch.newStories.length > 0 && (
        <>
          <div className="label">New stories</div>
          <ul className="facts">
            {ch.newStories.map((s: any) => (
              <li key={s.clusterId}><Link to={`/story/${s.clusterId}`}>{s.headline}</Link></li>
            ))}
          </ul>
        </>
      )}
      {ch.significantUpdates.length > 0 && (
        <>
          <div className="label" style={{ marginTop: 8 }}>Significant updates</div>
          <ul className="facts">
            {ch.significantUpdates.map((s: any, i: number) => (
              <li key={i}><Link to={`/story/${s.clusterId}`}>{s.headline}</Link>: {s.text}</li>
            ))}
          </ul>
        </>
      )}
      {ch.corrections.length > 0 && (
        <>
          <div className="label" style={{ marginTop: 8 }}>Corrections and retractions</div>
          <ul className="facts">
            {ch.corrections.map((s: any, i: number) => (
              <li key={i}><Link to={`/story/${s.clusterId}`}>{s.headline}</Link>: {s.text}</li>
            ))}
          </ul>
        </>
      )}
      {ch.lessRelevant.length > 0 && (
        <>
          <div className="label" style={{ marginTop: 8 }}>Less prominent now</div>
          <ul className="facts">
            {ch.lessRelevant.map((s: any) => (
              <li key={s.clusterId}><Link to={`/story/${s.clusterId}`}>{s.headline}</Link> <span className="meta">({s.reason})</span></li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function Watch({ items, onAdded }: { items: any[]; onAdded: () => void }) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ title: "", startsAt: "", certainty: "scheduled", why: "" });
  const { toast } = useApp();
  return (
    <section className="panel" style={{ marginTop: 20 }} aria-labelledby="watch">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <h2 id="watch" style={{ margin: 0 }}>What to watch</h2>
        {!STATIC && <button className="btn sm" onClick={() => setAdding(!adding)} aria-expanded={adding}>{adding ? "Cancel" : "Add an event"}</button>}
      </div>
      {adding && (
        <form
          style={{ marginTop: 12 }}
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api.post("/api/upcoming", { ...form, startsAt: new Date(form.startsAt).toISOString(), why: form.why || undefined });
              toast("Event added to your watch list");
              setAdding(false);
              setForm({ title: "", startsAt: "", certainty: "scheduled", why: "" });
              onAdded();
            } catch (err: any) {
              toast(err.message, "error");
            }
          }}
        >
          <div className="grid-2">
            <div className="field">
              <label htmlFor="ev-title">Event</label>
              <input id="ev-title" type="text" required minLength={3} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="ev-when">Date and time</label>
              <input id="ev-when" type="datetime-local" required value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="ev-cert">Certainty</label>
              <select id="ev-cert" value={form.certainty} onChange={(e) => setForm({ ...form, certainty: e.target.value })}>
                <option value="confirmed">Confirmed</option>
                <option value="scheduled">Scheduled</option>
                <option value="estimated">Estimated</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="ev-why">Why it matters (optional)</label>
              <input id="ev-why" type="text" value={form.why} onChange={(e) => setForm({ ...form, why: e.target.value })} />
            </div>
          </div>
          <button className="btn primary" type="submit">Add event</button>
        </form>
      )}
      {!items.length ? (
        <p className="meta">
          No upcoming events found. Events are added when stories from your sources mention scheduled dates (requires AI processing), or you can add your own.
        </p>
      ) : (
        <div className="list">
          {items.map((w) => (
            <div key={w.id}>
              <div style={{ fontWeight: 600 }}>{w.clusterId ? <Link to={`/story/${w.clusterId}`}>{w.title}</Link> : w.title}</div>
              <div className="meta">
                <span>{w.startsAt ? `${fmtDateTime(w.startsAt)} (${until(w.startsAt)})` : w.dateText}</span>
                <span className={`badge ${w.certainty === "confirmed" ? "ok" : w.certainty === "scheduled" ? "neutral" : "warn"}`}>{w.certainty}</span>
                {w.sourceUrl ? <ExternalLink href={w.sourceUrl}>{w.sourceName ?? "Source"}</ExternalLink> : w.sourceName && <span>{w.sourceName}</span>}
              </div>
              {w.why && <div style={{ fontSize: "0.9rem", marginTop: 4 }}>{w.why}</div>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
