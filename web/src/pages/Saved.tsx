import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useApp, useLoad } from "../lib/app";
import { ago, fmtDate } from "../lib/format";
import { Empty, ErrorState, ExternalLink, Loading } from "../components/ui";

const LIST_LABEL: Record<string, string> = { saved: "Saved", later: "Read later", following: "Followed stories" };

export function Saved() {
  const [tab, setTab] = useState("saved");
  const { data, error, loading, reload } = useLoad<any>("/api/saved");
  const history = useLoad<any>(tab === "history" ? "/api/history" : null);
  const { toast } = useApp();
  const lists: string[] = ["saved", "later", "following", ...(data?.lists ?? []).filter((l: string) => !LIST_LABEL[l])];
  const items = (data?.items ?? []).filter((i: any) => i.list === tab);

  const remove = async (i: any) => {
    await api.del("/api/saved", { targetType: i.targetType, targetId: i.targetId, list: i.list });
    reload(true);
  };
  const markRead = async (i: any, read: boolean) => {
    await api.patch("/api/saved/read", { targetType: i.targetType, targetId: i.targetId, list: i.list, read });
    reload(true);
  };

  return (
    <div className="page" style={{ maxWidth: 900 }}>
      <h1 className="hl hl-l">Saved</h1>
      <div className="tabs" role="tablist">
        {[...lists, "history"].map((l) => (
          <button key={l} role="tab" aria-selected={tab === l} className={tab === l ? "on" : ""} onClick={() => setTab(l)}>
            {l === "history" ? "Reading history" : LIST_LABEL[l] ?? l}
            {l !== "history" && data && ` (${data.items.filter((i: any) => i.list === l).length})`}
          </button>
        ))}
      </div>
      {tab === "history" ? (
        <>
          <div className="toolbar">
            <span className="meta">Stories and articles you opened, most recent first.</span>
            <span className="grow" />
            <button
              className="btn sm danger"
              onClick={async () => {
                if (!window.confirm("Clear your reading history? Saved items and followed stories are kept.")) return;
                await api.del("/api/history");
                toast("Reading history cleared");
                history.reload();
              }}
            >
              Clear history
            </button>
          </div>
          {history.loading && !history.data && <Loading />}
          {history.data && !history.data.items.length && <Empty title="No reading history yet" />}
          <div className="list">
            {history.data?.items.map((h: any) => (
              <div key={`${h.target_type}-${h.target_id}`}>
                <Link to={`/${h.target_type === "article" ? "article" : "story"}/${h.target_id}`} style={{ fontWeight: 600 }}>{h.headline}</Link>
                <div className="meta"><span>{h.target_type === "article" ? "Article" : "Story"}</span><span>Read {ago(h.at)}</span></div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          {loading && !data && <Loading />}
          {error && <ErrorState error={error} retry={() => reload()} />}
          {data && !items.length && (
            <Empty title={`Nothing in ${LIST_LABEL[tab] ?? tab}`}>
              {tab === "following" ? "Follow a story from its page to track new developments and get alerts." : "Use the Save and Read later buttons on stories and articles."}
            </Empty>
          )}
          <div className="list">
            {items.map((i: any) => {
              const t = i.target;
              const href = i.targetType === "article" ? `/article/${t.id}` : i.targetType === "story" ? `/story/${t.id}` : `/quick-reads/${t.id}`;
              const title = i.targetType === "briefing" ? `Quick Reads, ${t.edition} edition of ${t.edition_date}${t.revision > 1 ? ` (revision ${t.revision})` : ""}` : t.headline;
              return (
                <div key={`${i.targetType}-${i.targetId}`} style={{ opacity: i.readAt ? 0.7 : 1 }}>
                  <Link to={href} style={{ fontWeight: 600 }}>{title}</Link>
                  {i.targetType === "article" && t.description && <p className="dek" style={{ fontSize: "0.92rem", margin: "4px 0" }}>{t.description.slice(0, 200)}</p>}
                  <div className="meta">
                    <span>{i.targetType === "article" ? t.source_name : i.targetType === "story" ? `Story · ${t.source_count} sources` : "Briefing"}</span>
                    {i.targetType === "article" && <span>Published {fmtDate(t.published_at)}</span>}
                    {i.targetType === "story" && <span>Last update {ago(t.last_update_at)}</span>}
                    <span>Saved {ago(i.savedAt)}</span>
                    {i.readAt && <span>Read</span>}
                    {t.link_status === "gone" && <span className="badge warn">Original link no longer available</span>}
                    {i.targetType === "article" && t.link_status !== "gone" && <ExternalLink href={t.canonical_url}>Original</ExternalLink>}
                  </div>
                  <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                    <button className="btn sm" onClick={() => markRead(i, !i.readAt)}>{i.readAt ? "Mark unread" : "Mark read"}</button>
                    <button className="btn sm ghost" onClick={() => remove(i)}>Remove</button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
