import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { useApp, useLoad } from "../lib/app";
import { ago, fmtDateTime, fmtTime, shortSource, until } from "../lib/format";
import { ConfigNotice, Empty, ErrorState, ExternalLink, Icon, Loading, SaveButton, StoryBadges, StoryCard } from "../components/ui";

const KIND_LABEL: Record<string, string> = {
  first_report: "First report",
  update: "Update",
  new_source: "Also reported",
  official: "Official statement",
  correction: "Correction",
  retraction: "Retraction",
};
const TYPE_LABEL: Record<string, string> = { news: "News", opinion: "Opinion", analysis: "Analysis", live: "Live coverage", press_release: "Press release" };

export function StoryPage() {
  const { id } = useParams();
  const { data, error, loading, reload, setData } = useLoad<any>(`/api/story/${id}`, {
    liveOn: ["cluster", "articles"],
    liveUrl: `/api/story/${id}?visit=0`,
    liveFilter: (type, e) => (type === "cluster" ? e?.clusterId === Number(id) : (e?.clusterIds ?? []).includes(Number(id))),
  });
  const { status, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [moreTimeline, setMoreTimeline] = useState(false);
  const [moreCoverage, setMoreCoverage] = useState(false);

  if (loading && !data) return <div className="page"><Loading lines={10} /></div>;
  if (error) return <div className="page"><ErrorState error={error} retry={() => reload()} /></div>;
  if (!data) return null;
  if (data.hidden) {
    return (
      <div className="page">
        <Empty title="This story is only covered by sources you have turned off">
          {data.hiddenCount} article{data.hiddenCount === 1 ? "" : "s"} about it come from sources excluded from your newspaper. <Link to="/sources">Manage sources</Link>.
        </Empty>
      </div>
    );
  }
  const d = data;
  const aiConfigured = status?.ai?.status === "configured";
  const sig = d.timeline.filter((e: any) => e.significant || showAll);

  const summarize = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/api/story/${d.id}/summarize`);
      if (r.status === "not_configured") toast("AI summaries are not configured on this server", "error");
      else if (r.status === "error") toast(r.error ?? "Summary failed", "error");
      const fresh = await api.get(`/api/story/${d.id}?visit=0`);
      setData(fresh);
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="two-col">
        <article style={{ minWidth: 0 }}>
          <div className="badges">
            <Link to={`/section/${d.category}`} className="kicker">{d.categoryLabel}</Link>
            <StoryBadges s={{ ...d.card, isBreaking: d.isBreaking, status: d.status }} />
          </div>
          <h1 className="hl hl-xl" style={{ margin: "10px 0" }}>{d.headline}</h1>
          <div className="byline">
            <span><b>{d.corroboration.publishers}</b> publisher{d.corroboration.publishers === 1 ? "" : "s"}, <b>{d.articles.length}</b> article{d.articles.length === 1 ? "" : "s"}</span>
            <span>First reported {fmtDateTime(d.firstPublishedAt)}</span>
            <span>Last meaningful update {ago(d.lastUpdateAt)}</span>
            <span>Importance {d.importance}</span>
          </div>
          {d.personalReasons?.length > 0 && <div className="personal" style={{ marginBottom: 10 }}>In your edition because: {d.personalReasons.join(" · ")}</div>}

          {d.sinceLastVisit && (d.sinceLastVisit.events.length > 0 || d.sinceLastVisit.newArticles > 0) && (
            <div className="since-visit" role="status">
              <strong>Since your last visit ({ago(d.sinceLastVisit.lastVisitAt)}):</strong>{" "}
              {d.sinceLastVisit.newArticles} new article{d.sinceLastVisit.newArticles === 1 ? "" : "s"}
              {d.sinceLastVisit.events.length > 0 && (
                <ul className="facts">
                  {d.sinceLastVisit.events.map((e: any, i: number) => (
                    <li key={i}>{KIND_LABEL[e.kind] ?? e.kind}: {e.text}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="actions">
            <SaveButton type="story" id={d.id} list="following" initial={d.following} labels={["Follow story", "Following"]} />
            <SaveButton type="story" id={d.id} initial={d.saved} />
            <a className="btn sm" href="#ask"><Icon name="ask" size={15} /> Ask about this story</a>
          </div>

          {d.image && <HeroImage img={d.image} />}

          <nav className="story-toc" aria-label="On this page">
            {d.ai.summary ? <a href="#summary">Summary</a> : d.extracted && <a href="#summary">In brief</a>}
            {d.extracted?.keyFacts?.length > 0 && !d.ai.summary && <a href="#facts">Key facts</a>}
            {d.extracted?.story?.length > 0 && !d.ai.summary && <a href="#full-story">Full story</a>}
            {d.extracted?.quotes?.length > 0 && !d.ai.summary && <a href="#quotes">Quotes</a>}
            <a href="#timeline">Timeline</a>
            <a href="#srcs">Coverage ({d.articles.length})</a>
          </nav>

          <Synthesis d={d} aiConfigured={aiConfigured} busy={busy} onSummarize={summarize} />

          {d.corrections.length > 0 && (
            <div className="notice config" style={{ margin: "18px 0" }} role="note">
              <div>
                <strong>Corrections and retractions</strong>
                {d.corrections.map((c: any, i: number) => (
                  <div key={i}>{fmtDateTime(c.at)}: {c.text}</div>
                ))}
              </div>
            </div>
          )}

          <section id="timeline" style={{ marginTop: 28 }} aria-labelledby="tl">
            <div className="section-title">
              <h2 id="tl">Timeline</h2>
              <label className="check" style={{ fontSize: "0.8rem" }}>
                <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Include every new report
              </label>
            </div>
            <ol className="timeline">
              {[...sig].reverse().slice(0, moreTimeline ? undefined : 6).map((e: any) => (
                <li key={e.id} className={`${e.significant ? "sig" : ""} ${e.kind}`}>
                  <div className="when">
                    {fmtDateTime(e.at)} · {KIND_LABEL[e.kind] ?? e.kind}
                    {e.observedAt && Math.abs(Date.parse(e.observedAt) - Date.parse(e.at)) > 30 * 60_000 && ` · collected ${fmtTime(e.observedAt)}`}
                  </div>
                  <div>{e.articleId ? <Link to={`/article/${e.articleId}`}>{e.text}</Link> : e.text}</div>
                </li>
              ))}
            </ol>
            {sig.length > 6 && (
              <button className="btn sm ghost" onClick={() => setMoreTimeline((v) => !v)}>
                {moreTimeline ? "Show fewer" : `Show all ${sig.length} entries`}
              </button>
            )}
          </section>

          <section style={{ marginTop: 28 }} aria-labelledby="srcs">
            <div className="section-title">
              <h2 id="srcs">All coverage ({d.articles.length})</h2>
            </div>
            <p className="meta">
              {d.corroboration.independentSources} independent report{d.corroboration.independentSources === 1 ? "" : "s"}
              {d.corroboration.syndicatedGroups > 0 && ` · ${d.corroboration.syndicatedGroups} syndicated copies counted once`}
              {d.hiddenCount > 0 && ` · ${d.hiddenCount} more from sources you have turned off`}
            </p>
            {d.articles.slice(0, moreCoverage ? undefined : 8).map((a: any) => (
              <details className="source-entry" key={a.id}>
                <summary>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="meta">
                      <span className="src">{a.sourceName}</span>
                      <span>{TYPE_LABEL[a.articleType] ?? a.articleType}</span>
                      {a.sourceKind === "official" && <span className="badge official">Official</span>}
                      {a.correctionStatus !== "none" && a.correctionStatus && <span className="badge warn">{a.correctionStatus}</span>}
                      <span title={fmtDateTime(a.publishedAt)}>{a.publishedAtEstimated ? "seen" : "published"} {ago(a.publishedAt)}</span>
                      {a.textStatus && a.textStatus !== "pending" && (
                        <span className={`badge ${a.textStatus === "ok" ? "neutral" : "warn"}`} title={TEXT_STATUS[a.textStatus]}>{a.textStatus === "ok" ? "Full text" : "Excerpt only"}</span>
                      )}
                    </div>
                    <div style={{ fontWeight: 600, marginTop: 4 }}>{a.headline}</div>
                  </div>
                </summary>
                <div className="inner">
                  {a.contribution && <p><strong>Adds: </strong>{a.contribution}</p>}
                  {a.summary ? <p>{a.summary}</p> : a.description && <p>{a.description}</p>}
                  <div className="meta">
                    {a.author && <span>By {a.author}</span>}
                    <span>Published {fmtDateTime(a.publishedAt)}{a.publishedAtEstimated ? " (estimated, feed gave no date)" : ""}</span>
                    <span>Collected {fmtDateTime(a.retrievedAt)}</span>
                    {a.lastMeaningfulUpdateAt && a.lastMeaningfulUpdateAt !== a.publishedAt && <span>Updated {fmtDateTime(a.lastMeaningfulUpdateAt)}</span>}
                  </div>
                  <div className="actions" style={{ marginBottom: 0 }}>
                    <Link className="btn sm" to={`/article/${a.id}`}>Article details</Link>
                    {a.linkStatus === "gone" ? (
                      <span className="badge warn">Original link no longer available</span>
                    ) : (
                      <ExternalLink className="btn sm" href={a.url}>Read at {a.sourceName} <Icon name="external" size={13} /></ExternalLink>
                    )}
                  </div>
                </div>
              </details>
            ))}
            {d.articles.length > 8 && (
              <button className="btn sm ghost" style={{ marginTop: 8 }} onClick={() => setMoreCoverage((v) => !v)}>
                {moreCoverage ? "Show fewer" : `Show all ${d.articles.length} articles`}
              </button>
            )}
          </section>

          <Ask clusterId={d.id} />
        </article>

        <aside className="rail" aria-label="Story context">
          {d.official.length > 0 && (
            <div className="rail-box">
              <h2>Official sources</h2>
              <div className="list">
                {d.official.map((o: any) => (
                  <div key={o.id}>
                    <ExternalLink href={o.url}>{o.headline}</ExternalLink>
                    <div className="meta"><span>{o.sourceName}</span><span>{ago(o.publishedAt)}</span></div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {d.upcoming.length > 0 && (
            <div className="rail-box">
              <h2>What's next</h2>
              <div className="list">
                {d.upcoming.map((u: any) => (
                  <div key={u.id}>
                    <div style={{ fontWeight: 600 }}>{u.title}</div>
                    <div className="meta">
                      <span>{u.starts_at ? `${fmtDateTime(u.starts_at)} (${until(u.starts_at)})` : u.date_text}</span>
                      <span className="badge neutral">{u.certainty}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="rail-box">
            <h2>Why it ranks here</h2>
            {d.reasons.length ? (
              <ul className="facts">
                {d.reasons.map((r: any, i: number) => (
                  <li key={i}>{r.label} <span className="meta" style={{ display: "inline" }}>({r.points > 0 ? "+" : ""}{r.points})</span></li>
                ))}
              </ul>
            ) : (
              <p className="meta">No notable ranking signals.</p>
            )}
          </div>
          {d.related.length > 0 && (
            <div className="rail-box">
              <h2>Related stories</h2>
              <div className="list">
                {d.related.map((s: any) => (
                  <StoryCard key={s.id} s={s} variant="headline" />
                ))}
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

/** Inline source tags: the first outlet by name, the rest as "+N" (all listed in the tooltip). */
function Cites({ ids, articles }: { ids: number[]; articles: any[] }) {
  const found = ids.map((id) => articles.find((x) => x.id === id)).filter(Boolean);
  const names = [...new Set(found.map((a: any) => shortSource(a.sourceName)))];
  if (!found.length) return null;
  const first = found[0];
  return (
    <Link className="src-tag" to={`/article/${first.id}`} title={found.map((a: any) => `${a.sourceName}: ${a.headline}`).join("\n")}>
      {names[0]}
      {names.length > 1 && <span className="more"> +{names.length - 1}</span>}
    </Link>
  );
}

function HeroImage({ img }: { img: { url: string; sourceName: string | null; articleId: number | null } }) {
  const [ok, setOk] = useState(true);
  if (!ok) return null;
  return (
    <figure className="story-hero">
      <img src={img.url} alt="" referrerPolicy="no-referrer" decoding="async" fetchPriority="high" onError={() => setOk(false)} />
      {img.sourceName && <figcaption>Image via {img.articleId ? <Link to={`/article/${img.articleId}`}>{img.sourceName}</Link> : img.sourceName}</figcaption>}
    </figure>
  );
}

function Synthesis({ d, aiConfigured, busy, onSummarize }: { d: any; aiConfigured: boolean; busy: boolean; onSummarize: () => void }) {
  const ai = d.ai;
  const cov = ai.coverage;
  if (!ai.summary) {
    const ex = d.extracted;
    return (
      <section aria-label="Summary">
        {ex ? (
          <Extracted ex={ex} articles={d.articles} aiConfigured={aiConfigured} />
        ) : (
          d.card?.description && (
            <p className="dek">
              {d.card.description} <span className="meta" style={{ display: "inline" }}>— description from {d.card.lead.sourceName}</span>
            </p>
          )
        )}
        {!aiConfigured ? (
          ex ? null : (
            <ConfigNotice title="Story synthesis needs an AI key">
              A cross-source summary, key facts and coverage comparison are written by an AI model, which is not configured on this server (ANTHROPIC_API_KEY). All
              coverage is listed below with links to the originals.
            </ConfigNotice>
          )
        ) : ai.error ? (
          <div className="notice error" role="status">
            <div>
              <strong>The summary could not be generated</strong>
              {ai.error}
              <div style={{ marginTop: 8 }}><button className="btn sm" onClick={onSummarize} disabled={busy}>{busy ? "Working…" : "Try again"}</button></div>
            </div>
          </div>
        ) : (
          <div className="notice info" role="status">
            <div>
              <strong>Summary pending</strong>
              Stories are summarized in the background shortly after they are collected.
              <div style={{ marginTop: 8 }}><button className="btn sm" onClick={onSummarize} disabled={busy}>{busy ? "Summarizing…" : "Summarize now"}</button></div>
            </div>
          </div>
        )}
      </section>
    );
  }
  return (
    <section id="summary" aria-label="Summary">
      <p className="dek" style={{ fontSize: "1.15rem" }}>{ai.summary}</p>
      {ai.whyItMatters && (
        <div className="why" style={{ margin: "14px 0" }}>
          <strong>Why it matters</strong>
          {ai.whyItMatters}
        </div>
      )}
      {ai.keyFacts.length > 0 && (
        <div className="callout" style={{ margin: "14px 0" }}>
          <h3>Key facts</h3>
          <ul className="facts">
            {ai.keyFacts.map((f: any, i: number) => (
              <li key={i}>{f.text}<Cites ids={f.article_ids} articles={d.articles} /></li>
            ))}
          </ul>
        </div>
      )}
      {cov && (
        <details className="source-entry" style={{ margin: "14px 0" }}>
          <summary><strong>How the coverage compares</strong></summary>
          <div className="inner">
            {[
              ["Reported consistently", cov.consistent],
              ["Reported by only one source", cov.singleSource],
              ["Official claims not independently verified", cov.unverifiedOfficial],
              ["Differences in emphasis", cov.emphasis],
            ].map(([label, list]: any) =>
              list?.length ? (
                <div key={label} style={{ marginBottom: 10 }}>
                  <div className="label">{label}</div>
                  <ul className="facts">
                    {list.map((x: any, i: number) => (
                      <li key={i}>{x.text}<Cites ids={x.article_ids} articles={d.articles} /></li>
                    ))}
                  </ul>
                </div>
              ) : null,
            )}
            {ai.disputed.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <div className="label">Disputed or contradictory</div>
                <ul className="facts">
                  {ai.disputed.map((x: any, i: number) => (
                    <li key={i}>
                      {x.point}
                      <ul>
                        {x.positions.map((p: any, j: number) => (
                          <li key={j}>{p.text}<Cites ids={p.article_ids} articles={d.articles} /></li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {ai.unresolved.length > 0 && (
              <div>
                <div className="label">Open questions</div>
                <ul className="facts">
                  {ai.unresolved.map((x: string, i: number) => <li key={i}>{x}</li>)}
                </ul>
              </div>
            )}
          </div>
        </details>
      )}
      <p className="meta">
        AI synthesis of {cov?.basedOn ?? "the"} reports ({cov?.basis === "excerpts" ? "feed excerpts only, not full articles" : "including full text where feeds provide it"}) · generated {ago(ai.generatedAt)}
        {ai.stale && " · new reports arrived; an update is queued"}
        {cov?.removedForMissingSupport?.length > 0 && ` · ${cov.removedForMissingSupport.length} unsupported sentence(s) removed`}
        {aiConfigured && (
          <button className="btn sm ghost" onClick={onSummarize} disabled={busy} style={{ marginLeft: 6 }}>{busy ? "Updating…" : "Regenerate"}</button>
        )}
      </p>
    </section>
  );
}

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

const TEXT_STATUS: Record<string, string> = {
  ok: "Full text read",
  robots: "Publisher blocks automated reading; excerpt only",
  unavailable: "Full text unavailable (paywall or script page); excerpt only",
  failed: "Could not load the article; excerpt only",
  pending: "Full text not read yet",
};

/** Story overview compiled from the publishers' own sentences, used when no AI synthesis exists. */
function Extracted({ ex, articles, aiConfigured }: { ex: any; articles: any[]; aiConfigured: boolean }) {
  return (
    <>
      {ex.summary.length > 0 && (
        <section id="summary" className="brief-box" aria-labelledby="in-brief">
          <h2 id="in-brief">In brief</h2>
          <ul>
            {ex.summary.map((q: any, i: number) => (
              <li key={i}>{q.text} <Cites ids={q.article_ids} articles={articles} /></li>
            ))}
          </ul>
        </section>
      )}

      {ex.keyFacts.length > 0 && (
        <section id="facts" className="story-section" aria-labelledby="facts-h">
          <h2 id="facts-h" className="section-h">Key facts</h2>
          <ul className="fact-list">
            {ex.keyFacts.map((f: any, i: number) => (
              <li key={i}>{f.text} <Cites ids={f.article_ids} articles={articles} /></li>
            ))}
          </ul>
        </section>
      )}

      {ex.story?.length > 0 && (
        <section id="full-story" className="story-section" aria-labelledby="full-story-h">
          <h2 id="full-story-h" className="section-h">The full story</h2>
          <div className="story-body">
            {chunk(ex.story, 2).map((para: any[], i: number) => (
              <p key={i}>
                {para.map((q: any, j: number) => (
                  <span key={j}>{q.text} <Cites ids={q.article_ids} articles={articles} /> </span>
                ))}
              </p>
            ))}
          </div>
        </section>
      )}

      {ex.quotes?.length > 0 && (
        <section id="quotes" className="story-section" aria-labelledby="quotes-h">
          <h2 id="quotes-h" className="section-h">What people said</h2>
          {ex.quotes.map((f: any, i: number) => (
            <blockquote key={i} className="pull-quote">
              {f.text}
              <footer><Cites ids={f.article_ids} articles={articles} /></footer>
            </blockquote>
          ))}
        </section>
      )}

      {(ex.shared.length > 0 || ex.singleSource.length > 0 || ex.headlines.length > 0) && (
        <details className="source-entry" style={{ margin: "18px 0" }}>
          <summary><strong>How the coverage compares</strong></summary>
          <div className="inner">
            {ex.shared.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div className="label">Named by several outlets</div>
                <div className="chips">
                  {ex.shared.map((e: any) => (
                    <span key={e.name} className="badge neutral" title={`Mentioned by ${e.publishers} outlets`}>{e.name} · {e.publishers}</span>
                  ))}
                </div>
              </div>
            )}
            {ex.singleSource.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div className="label">Details only one outlet mentions</div>
                <ul className="fact-list">
                  {ex.singleSource.map((x: any, i: number) => (
                    <li key={i}>{x.text} <Cites ids={x.article_ids} articles={articles} /></li>
                  ))}
                </ul>
              </div>
            )}
            {ex.headlines.length > 0 && (
              <div>
                <div className="label">How each outlet headlines it</div>
                <ul className="fact-list">
                  {ex.headlines.map((h: any) => (
                    <li key={h.article_id}><Link to={`/article/${h.article_id}`}>{h.headline}</Link> <span className="src-tag static">{shortSource(h.source_name)}</span></li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </details>
      )}
      <p className="meta">
        Quoted word for word from {ex.basedOn} report{ex.basedOn === 1 ? "" : "s"} by {ex.publishers} outlet{ex.publishers === 1 ? "" : "s"}
        {ex.fullTextCount ? ` (full text read for ${ex.fullTextCount})` : " (feed excerpts so far; full articles are being read)"}. Picked automatically, not written by AI;
        each fact and quote appears once.
        {!aiConfigured && " A written synthesis appears once an Anthropic API key is added."}
      </p>
    </>
  );
}

export function Ask({ clusterId }: { clusterId?: number }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<any>(null);
  return (
    <section id="ask" className="panel" style={{ marginTop: 28 }} aria-labelledby="ask-h">
      <h2 id="ask-h">{clusterId ? "Ask about this story" : "Ask about the news"}</h2>
      <p className="meta" style={{ marginTop: 0 }}>Answers use only articles collected from your sources and cite them. If they do not cover your question, the answer says so.</p>
      <form
        className="toolbar"
        onSubmit={async (e) => {
          e.preventDefault();
          if (q.trim().length < 3) return;
          setBusy(true);
          setRes(null);
          try {
            setRes(await api.post("/api/ask", { question: q.trim(), clusterId }));
          } catch (err: any) {
            setRes({ status: "error", error: err.body?.error ?? err.message });
          } finally {
            setBusy(false);
          }
        }}
      >
        <label htmlFor={`ask-${clusterId ?? "all"}`} className="sr-only">Question</label>
        <input id={`ask-${clusterId ?? "all"}`} type="text" className="grow" placeholder="e.g. What has been officially confirmed?" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn primary" disabled={busy}>{busy ? "Thinking…" : "Ask"}</button>
      </form>
      {res?.status === "error" && <div className="notice error" role="alert"><div>{res.error}</div></div>}
      {res?.status === "not_configured" && <ConfigNotice title="Answers need an AI key">{res.message}</ConfigNotice>}
      {res?.answer && (
        <div style={{ marginTop: 6 }}>
          <p style={{ fontFamily: "var(--font-serif)", fontSize: "1.05rem" }}>{res.answer}</p>
          <div className="meta">
            {res.support && <span>Support in sources: {res.support}</span>}
            {res.independentConfirmation !== undefined && <span>{res.independentConfirmation ? "Independently confirmed by more than one outlet" : "Not independently confirmed"}</span>}
          </div>
        </div>
      )}
      {res?.sources?.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className="label">{res.answer ? "Sources consulted" : "Most relevant articles"}</div>
          <ul className="facts">
            {res.sources.map((s: any) => (
              <li key={s.articleId} style={{ fontWeight: res.citations?.includes(s.articleId) ? 600 : 400 }}>
                <Link to={`/article/${s.articleId}`}>{s.headline}</Link> <span className="meta" style={{ display: "inline" }}>— {s.sourceName}, {ago(s.publishedAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
