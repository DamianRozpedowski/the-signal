import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { useApp, useLoad } from "../lib/app";
import { ago, fmtDateTime } from "../lib/format";
import { ConfigNotice, ErrorState, ExternalLink, Icon, Loading, SaveButton } from "../components/ui";

const SIZES = ["sm", "md", "lg", "xl"];

export function ArticlePage() {
  const { id } = useParams();
  const { data: a, error, loading, reload, setData } = useLoad<any>(`/api/article/${id}`);
  const { prefs, savePrefs, status, toast } = useApp();
  const [focus, setFocus] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.body.classList.toggle("focus-reading", focus);
    return () => document.body.classList.remove("focus-reading");
  }, [focus]);

  if (loading && !a) return <div className="page reader"><Loading lines={8} /></div>;
  if (error) return <div className="page"><ErrorState error={error} retry={() => reload()} /></div>;
  if (!a) return null;
  const size = prefs?.textSize ?? "md";
  const bump = (d: number) => {
    const i = Math.max(0, Math.min(SIZES.length - 1, SIZES.indexOf(size) + d));
    savePrefs({ textSize: SIZES[i] }).catch((e) => toast(e.message, "error"));
  };
  const aiConfigured = status?.ai?.status === "configured";

  return (
    <div className={`page reader ${focus ? "focus-mode" : ""}`}>
      <div className="toolbar" role="toolbar" aria-label="Reading controls">
        {a.clusterId && !focus && <Link to={`/story/${a.clusterId}`} className="btn sm ghost">← Full story and other sources</Link>}
        <span className="grow" />
        <button className="btn sm" onClick={() => bump(-1)} aria-label="Smaller text" disabled={size === "sm"}>A−</button>
        <button className="btn sm" onClick={() => bump(1)} aria-label="Larger text" disabled={size === "xl"}>A+</button>
        <button className={`btn sm ${focus ? "on" : ""}`} aria-pressed={focus} onClick={() => setFocus(!focus)}>
          {focus ? "Exit focus mode" : "Focus mode"}
        </button>
      </div>
      <div className="badges">
        <span className="kicker">{a.categoryLabel}</span>
        {a.articleType !== "news" && <span className="badge opinion">{a.articleType.replace("_", " ")}</span>}
        {a.correctionStatus && a.correctionStatus !== "none" && <span className="badge warn">{a.correctionStatus}</span>}
      </div>
      <h1 className="hl hl-xl">{a.headline}</h1>
      <div className="byline">
        <span><b>{a.source.name}</b></span>
        {a.author && <span>By {a.author}</span>}
        <span title={a.publishedAtEstimated ? "The feed gave no publication date; this is when it was first seen." : undefined}>
          {a.publishedAtEstimated ? "First seen" : "Published"} {fmtDateTime(a.publishedAt)}
        </span>
        {a.lastMeaningfulUpdateAt && a.lastMeaningfulUpdateAt !== a.publishedAt && <span>Updated {fmtDateTime(a.lastMeaningfulUpdateAt)}</span>}
        <span>Collected {ago(a.retrievedAt)}</span>
      </div>
      {!a.source.active && (
        <div className="notice info" style={{ marginBottom: 14 }}>
          <div>This article is from {a.source.name}, which is currently turned off in your sources.</div>
        </div>
      )}
      {a.originalHeadline && a.originalHeadline !== a.headline && <p className="meta">Headline changed; originally: “{a.originalHeadline}”</p>}

      <div className="body">
        {a.summary ? (
          <>
            <p>{a.summary}</p>
            <p className="meta">
              AI summary based on {a.summaryBasis === "full_feed_text" ? "the text supplied in the publisher's feed" : "the publisher's feed excerpt, not the full article"} · {ago(a.summaryAt)}
            </p>
          </>
        ) : a.description ? (
          <>
            <p>{a.description}</p>
            <p className="meta">Description provided by {a.source.name} in its feed.</p>
          </>
        ) : (
          <p className="meta">The publisher's feed did not include a description. Read the full article at the source.</p>
        )}
        {a.content && !a.summary && (
          <details style={{ margin: "10px 0 16px" }}>
            <summary className="label" style={{ cursor: "pointer" }}>Text supplied in the feed</summary>
            {a.content.split(/\n{2,}/).slice(0, 30).map((p: string, i: number) => <p key={i}>{p}</p>)}
          </details>
        )}
      </div>
      {!a.summary && !aiConfigured && (
        <ConfigNotice title="AI summaries are not configured">Set ANTHROPIC_API_KEY on the server to add short neutral summaries.</ConfigNotice>
      )}
      {!a.summary && aiConfigured && (
        <button
          className="btn sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api.post(`/api/article/${a.id}/summarize`);
              if (r.status === "error") toast(r.error ?? "Summary failed", "error");
              setData(await api.get(`/api/article/${a.id}?visit=0`));
            } catch (e: any) {
              toast(e.message, "error");
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Summarizing…" : "Summarize"}
        </button>
      )}

      <div className="actions">
        {a.linkStatus === "gone" ? (
          <span className="badge warn">The original link no longer works</span>
        ) : (
          <ExternalLink className="btn primary" href={a.url}>Read the full article at {a.source.name} <Icon name="external" size={14} /></ExternalLink>
        )}
        <SaveButton type="article" id={a.id} initial={a.saved} />
        <SaveButton type="article" id={a.id} list="later" initial={a.readLater} labels={["Read later", "In Read later"]} />
      </div>

      {!focus && (
        <>
          {a.topics.length > 0 && (
            <div className="chips" style={{ margin: "10px 0" }}>
              {a.topics.map((t: any) => (
                <Link key={t.id} to={`/topics/${t.id}`} className="chip">{t.name}</Link>
              ))}
            </div>
          )}
          {a.related.length > 0 && (
            <section className="panel" style={{ marginTop: 18 }}>
              <h2>Other coverage of this story</h2>
              <ul className="facts">
                {a.related.map((r: any) => (
                  <li key={r.id}>
                    <Link to={`/article/${r.id}`}>{r.headline}</Link> <span className="meta" style={{ display: "inline" }}>— {r.sourceName}, {ago(r.publishedAt)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {a.revisions.length > 0 && (
            <section className="panel" style={{ marginTop: 18 }}>
              <h2>Changes detected in the feed</h2>
              <ul className="facts">
                {a.revisions.map((r: any, i: number) => (
                  <li key={i}>
                    {fmtDateTime(r.at)}: {r.field} changed{r.significant ? " (significant)" : ""}
                    {r.field === "headline" && <> from “{r.old_value}” to “{r.new_value}”</>}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
