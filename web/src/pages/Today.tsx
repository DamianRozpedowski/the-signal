import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useApp, useLoad } from "../lib/app";
import { ago, fmtDateTime, fmtLongDate, fmtTime, getTimeZone, until } from "../lib/format";
import { ConfigNotice, Empty, ErrorState, ExternalLink, Icon, Loading, StoryBadges, StoryCard, StoryMeta, truncate } from "../components/ui";

const CATEGORY_LABELS: Record<string, string> = {
  world: "World", us: "U.S. News", politics: "Politics & Policy", business: "Business & Economy", technology: "Technology & AI",
  science: "Science", health: "Health", local: "Local", climate: "Climate & Environment", energy: "Energy", education: "Education",
  transportation: "Transportation", sports: "Sports", culture: "Culture & Arts", entertainment: "Entertainment",
};

/** Matches the server's edition boundaries (Settings → Quick Reads cutoffs), in the reader's time zone. */
function editionLabel(prefs: any) {
  const parts = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: getTimeZone() }).format(new Date());
  const m = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
  const now = m(parts);
  const morning = m(prefs?.briefing?.morningCutoff ?? "06:00");
  const evening = m(prefs?.briefing?.eveningCutoff ?? "18:00");
  return now >= morning && now < evening ? "Morning Edition" : "Evening Edition";
}

function LayoutEditor({ prefs, onClose }: { prefs: any; onClose: () => void }) {
  const { savePrefs, toast } = useApp();
  const [hp, setHp] = useState(() => structuredClone(prefs.homepage));
  const [density, setDensity] = useState(prefs.density);
  const [location, setLocation] = useState(prefs.location ?? { label: "", code: "" });
  const move = (i: number, d: number) => {
    const s = [...hp.sections];
    const j = i + d;
    if (j < 0 || j >= s.length) return;
    [s[i], s[j]] = [s[j], s[i]];
    setHp({ ...hp, sections: s });
  };
  return (
    <div className="panel" style={{ marginBottom: 24 }} aria-label="Edit homepage layout">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>Edit your front page</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            className="btn"
            onClick={async () => {
              const r = await api.get("/api/prefs");
              setHp(structuredClone(r.defaults.homepage));
              setDensity(r.defaults.density);
              toast("Default layout restored. Save to apply.");
            }}
          >
            Restore default
          </button>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={async () => {
              try {
                await savePrefs({ homepage: hp, density, location: location.code ? location : null });
                toast("Front page saved");
                onClose();
              } catch (e: any) {
                toast(e.message, "error");
              }
            }}
          >
            Save layout
          </button>
        </div>
      </div>
      <div className="grid-2" style={{ marginTop: 16 }}>
        <div>
          <div className="label" style={{ marginBottom: 8 }}>Sections (order, visibility, number of stories)</div>
          <div className="table-wrap">
            <table className="data">
              <tbody>
                {hp.sections.map((s: any, i: number) => (
                  <tr key={s.key}>
                    <td style={{ width: 70 }}>
                      <button className="icon-btn" style={{ width: 28, height: 28 }} aria-label={`Move ${CATEGORY_LABELS[s.key]} up`} onClick={() => move(i, -1)}>
                        <Icon name="up" size={14} />
                      </button>
                      <button className="icon-btn" style={{ width: 28, height: 28 }} aria-label={`Move ${CATEGORY_LABELS[s.key]} down`} onClick={() => move(i, 1)}>
                        <Icon name="down" size={14} />
                      </button>
                    </td>
                    <td>
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={s.enabled}
                          onChange={(e) => setHp({ ...hp, sections: hp.sections.map((x: any) => (x.key === s.key ? { ...x, enabled: e.target.checked } : x)) })}
                        />
                        {CATEGORY_LABELS[s.key] ?? s.key}
                      </label>
                    </td>
                    <td style={{ width: 90 }}>
                      <label className="sr-only" htmlFor={`count-${s.key}`}>Stories in {CATEGORY_LABELS[s.key]}</label>
                      <select id={`count-${s.key}`} value={s.count} onChange={(e) => setHp({ ...hp, sections: hp.sections.map((x: any) => (x.key === s.key ? { ...x, count: Number(e.target.value) } : x)) })}>
                        {[2, 3, 4, 5, 6, 8, 10].map((n) => (
                          <option key={n} value={n}>{n}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <div className="field">
            <label htmlFor="topcount">Top stories under the lead</label>
            <select id="topcount" value={hp.topCount} onChange={(e) => setHp({ ...hp, topCount: Number(e.target.value) })}>
              {[4, 5, 6, 8, 10].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <span className="label">Card style</span>
            <div className="seg" role="group" aria-label="Card style">
              <button className={density === "expanded" ? "on" : ""} onClick={() => setDensity("expanded")}>Expanded</button>
              <button className={density === "compact" ? "on" : ""} onClick={() => setDensity("compact")}>Compact</button>
            </div>
          </div>
          <label className="check" style={{ marginBottom: 10 }}>
            <input type="checkbox" checked={hp.showSidebar} onChange={(e) => setHp({ ...hp, showSidebar: e.target.checked })} />
            Show the editorial sidebar
          </label>
          <br />
          <label className="check" style={{ marginBottom: 14 }}>
            <input type="checkbox" checked={hp.showImages} onChange={(e) => setHp({ ...hp, showImages: e.target.checked })} />
            Show images
          </label>
          <div className="field">
            <label htmlFor="loc">Local coverage area</label>
            <select
              id="loc"
              value={location.code}
              onChange={(e) => {
                const opt = LOCATIONS.find((l) => l.code === e.target.value);
                setLocation(opt ?? { label: "", code: "" });
              }}
            >
              <option value="">None</option>
              {LOCATIONS.map((l) => (
                <option key={l.code} value={l.code}>{l.label}</option>
              ))}
            </select>
            <span className="hint">Stories mentioning this area are surfaced in Local News. Add local outlets on the Sources page.</span>
          </div>
          <p className="hint" style={{ fontSize: "0.82rem", color: "var(--muted)" }}>
            Preferred sources are chosen on the <Link to="/sources">Sources</Link> page; hidden topics on <Link to="/topics">Topics</Link>; personalization strength in{" "}
            <Link to="/settings#personalization">Settings</Link>.
          </p>
        </div>
      </div>
    </div>
  );
}

export const LOCATIONS = [
  ...Object.entries({
    "US-AL": "Alabama", "US-AK": "Alaska", "US-AZ": "Arizona", "US-AR": "Arkansas", "US-CA": "California", "US-CO": "Colorado", "US-CT": "Connecticut",
    "US-DE": "Delaware", "US-DC": "Washington, D.C.", "US-FL": "Florida", "US-GA": "Georgia", "US-HI": "Hawaii", "US-ID": "Idaho", "US-IL": "Illinois",
    "US-IN": "Indiana", "US-IA": "Iowa", "US-KS": "Kansas", "US-KY": "Kentucky", "US-LA": "Louisiana", "US-ME": "Maine", "US-MD": "Maryland",
    "US-MA": "Massachusetts", "US-MI": "Michigan", "US-MN": "Minnesota", "US-MS": "Mississippi", "US-MO": "Missouri", "US-MT": "Montana",
    "US-NE": "Nebraska", "US-NV": "Nevada", "US-NH": "New Hampshire", "US-NJ": "New Jersey", "US-NM": "New Mexico", "US-NY": "New York",
    "US-NC": "North Carolina", "US-ND": "North Dakota", "US-OH": "Ohio", "US-OK": "Oklahoma", "US-OR": "Oregon", "US-PA": "Pennsylvania",
    "US-RI": "Rhode Island", "US-SC": "South Carolina", "US-SD": "South Dakota", "US-TN": "Tennessee", "US-TX": "Texas", "US-UT": "Utah",
    "US-VT": "Vermont", "US-VA": "Virginia", "US-WA": "Washington State", "US-WV": "West Virginia", "US-WI": "Wisconsin", "US-WY": "Wyoming",
  }).map(([code, label]) => ({ code, label })),
  ...Object.entries({ GB: "United Kingdom", CA: "Canada", AU: "Australia", IE: "Ireland", IN: "India", DE: "Germany", FR: "France" }).map(([code, label]) => ({ code, label })),
];

export function Today() {
  const { prefs, status } = useApp();
  const { data, error, loading, reload } = useLoad<any>("/api/today", { liveOn: ["articles", "cluster", "briefing"] });
  const [editing, setEditing] = useState(false);
  const compact = prefs?.density === "compact";
  const showImages = prefs?.homepage?.showImages !== false;

  return (
    <div className={`page ${compact ? "compact" : ""}`}>
      <div className="masthead">
        <h1>The Signal</h1>
      </div>
      <div className="masthead-meta">
        <span>{fmtLongDate()}</span>
        <span className="edition">{editionLabel(prefs)}</span>
        <span style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <span>{data?.refresh?.lastSuccessAt ? `Last refreshed ${fmtTime(data.refresh.lastSuccessAt)}` : "Awaiting first refresh"}</span>
          <Link to="/quick-reads" style={{ fontWeight: 700 }}>Quick Reads →</Link>
          <button className="btn sm ghost" onClick={() => setEditing(!editing)} aria-expanded={editing}>
            {editing ? "Close editor" : "Edit layout"}
          </button>
        </span>
      </div>

      {editing && prefs && <LayoutEditor prefs={prefs} onClose={() => setEditing(false)} />}
      {loading && !data && <Loading lines={8} />}
      {error && <ErrorState error={error} retry={reload} />}
      {data && <FrontPage data={data} compact={compact} showImages={showImages} showSidebar={prefs?.homepage?.showSidebar !== false} status={status} />}
    </div>
  );
}

function FrontPage({ data, compact, showImages, showSidebar, status }: { data: any; compact: boolean; showImages: boolean; showSidebar: boolean; status: any }) {
  const { lead, top, breaking, sections, sidebar, health } = data;
  if (!health.total) {
    return (
      <Empty title="No sources are enabled">
        Your newspaper is built from the sources you choose. <Link to="/sources">Open the source checklist</Link> or apply a preset to get started.
      </Empty>
    );
  }
  if (!lead && !top.length) {
    const neverFetched = health.pending === health.total;
    return (
      <>
        {health.failing.length > 0 && <SourceProblems health={health} />}
        <Empty title={neverFetched ? "Collecting today's news…" : "No stories in the last 48 hours from your sources"}>
          {neverFetched
            ? "Your sources are being fetched for the first time. Stories will appear here automatically as they arrive."
            : "Your enabled sources have not published anything recently, or they are failing to update. Check the Sources page for details."}
          <div style={{ marginTop: 10 }}>
            <Link className="btn" to="/sources">Review sources</Link>
          </div>
        </Empty>
      </>
    );
  }
  return (
    <div className={`front ${showSidebar ? "" : "no-sidebar"}`}>
      <div style={{ minWidth: 0 }}>
        {health.failing.length > 0 && <SourceProblems health={health} />}
        {breaking.length > 0 ? (
          <section className="breaking-strip" aria-label="Breaking news">
            <h2>
              <span className="dot live" /> Breaking news
            </h2>
            {breaking.map((s: any) => (
              <div className="item" key={s.id}>
                <span className="meta" style={{ whiteSpace: "nowrap" }}>{fmtTime(s.breakingAt ?? s.firstPublishedAt)}</span>
                <span>
                  <Link to={`/story/${s.id}`} style={{ fontWeight: 600 }}>{s.headline}</Link>
                  <span className="meta" style={{ display: "inline-flex", marginLeft: 8 }}>
                    {s.lead.sourceName}
                    {s.sourceCount > 1 ? ` + ${s.sourceCount - 1} more` : ""} · <Link to={`/story/${s.id}#timeline`}>timeline</Link>
                  </span>
                </span>
              </div>
            ))}
          </section>
        ) : (
          <div className="neutral-note">No breaking news right now. Stories are marked breaking only for significant, recent, corroborated developments.</div>
        )}

        {lead && <LeadStory s={lead} showImage={showImages} />}

        <div className="top-grid">
          {top.map((s: any, i: number) => (
            <div key={s.id} className={`card ${i < 2 ? "span-6" : compact ? "span-4" : i < 5 ? "span-4" : "span-6"}`}>
              <StoryCard s={s} variant={compact ? "compact" : i < 2 ? "standard" : "compact"} showImage={showImages && i < 2} showReasons={i < 2} />
            </div>
          ))}
        </div>

        <div className="sections">
          {sections.map((sec: any) => (
            <section key={sec.key} className="section-block" aria-labelledby={`sec-${sec.key}`}>
              <div className="section-title">
                <h2 id={`sec-${sec.key}`}>{sec.label}</h2>
                <Link to={`/section/${sec.key}`}>View all{sec.total ? ` (${sec.total})` : ""} →</Link>
              </div>
              {!sec.stories.length ? (
                <p className="meta" style={{ padding: "6px 0 18px" }}>
                  {sec.total
                    ? "The biggest stories in this section are already featured above."
                    : sec.key === "local" && !sec.label.includes(":")
                      ? "Choose a local coverage area with Edit layout, and add local outlets on the Sources page."
                      : "No stories from your sources in this section in the last 48 hours."}
                </p>
              ) : (
                <div className="list">
                  {sec.stories.map((s: any, i: number) => (
                    <StoryCard key={s.id} s={s} variant={i === 0 && !compact ? "row" : "headline"} showImage={showImages} />
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      </div>
      {showSidebar && <Rail sidebar={sidebar} />}
    </div>
  );
}

function SourceProblems({ health }: { health: any }) {
  return (
    <div className="notice error" style={{ marginBottom: 18 }} role="status">
      <div>
        <strong>
          {health.failing.length} of your {health.total} sources {health.failing.length === 1 ? "is" : "are"} not updating
        </strong>
        {health.failing.slice(0, 3).map((f: any) => f.name).join(", ")}
        {health.failing.length > 3 ? ` and ${health.failing.length - 3} more` : ""}. Stories from them may be out of date. <Link to="/sources?filter=failing">See details</Link>
      </div>
    </div>
  );
}

function LeadStory({ s, showImage }: { s: any; showImage: boolean }) {
  const hasImg = showImage && s.lead.imageUrl;
  const why = s.whyItMatters ?? s.reasons?.filter((r: any) => r.points > 0).slice(0, 3).map((r: any) => r.label).join(" · ");
  return (
    <article className={`lead-wrap ${hasImg ? "" : "no-image"}`} aria-label="Lead story">
      {hasImg && (
        <Link to={`/story/${s.id}`} tabIndex={-1} aria-hidden="true">
          <img className="lead-img" src={s.lead.imageUrl} alt="" referrerPolicy="no-referrer" decoding="async" fetchPriority="high" onError={(e) => ((e.target as HTMLElement).style.display = "none")} />
        </Link>
      )}
      <div className="lead-body">
        <div className="card badges" style={{ flexDirection: "row" }}>
          <span className="kicker">{s.categoryLabel}</span>
          <StoryBadges s={s} />
        </div>
        <Link to={`/story/${s.id}`}>
          <h2 className="hl-xl">{s.headline}</h2>
        </Link>
        {(s.summary || s.description) && <p className="dek">{truncate(s.summary ?? s.description, 320)}</p>}
        {!s.summary && s.description && <span className="meta">Description from {s.lead.sourceName}</span>}
        {why && (
          <div className="why">
            <strong>{s.whyItMatters ? "Why it matters" : "Why it leads"}</strong>
            {why}
          </div>
        )}
        <StoryMeta s={s} />
        <div className="actions" style={{ margin: 0 }}>
          <Link className="btn primary sm" to={`/story/${s.id}`}>
            Full coverage ({s.sourceCount} source{s.sourceCount === 1 ? "" : "s"})
          </Link>
          <ExternalLink href={s.lead.url} className="btn sm">
            Read at {s.lead.sourceName} <Icon name="external" size={14} />
          </ExternalLink>
        </div>
      </div>
    </article>
  );
}

function Rail({ sidebar }: { sidebar: any }) {
  return (
    <aside className="rail" aria-label="Editorial sidebar">
      <div className="rail-box">
        <h3>
          Quick Reads <Link to="/quick-reads" style={{ fontSize: "0.72rem" }}>Open →</Link>
        </h3>
        {sidebar.quickReads ? (
          <div className="qr-preview">
            <div className="meta" style={{ marginBottom: 6 }}>
              {sidebar.quickReads.edition} · generated {ago(sidebar.quickReads.generatedAt)}
            </div>
            {sidebar.quickReads.bigPicture ? <p style={{ margin: "0 0 8px", fontFamily: "var(--font-serif)" }}>{truncate(sidebar.quickReads.bigPicture, 240)}</p> : null}
            <ul>
              {sidebar.quickReads.headlines.map((h: any) => (
                <li key={h.clusterId}>
                  <Link to={`/story/${h.clusterId}`}>{h.headline}</Link>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="meta">No briefing yet. Open Quick Reads to prepare one from the stories collected so far.</p>
        )}
      </div>
      <div className="rail-box">
        <h3>
          Developing <small>editorially tracked</small>
        </h3>
        {sidebar.developing.length ? (
          <ul>
            {sidebar.developing.map((s: any) => (
              <li key={s.id}>
                <Link to={`/story/${s.id}`} className="hl">{s.headline}</Link>
                <div className="meta">Updated {ago(s.lastUpdateAt)} · {s.sourceCount} sources</div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="meta">No stories are actively developing right now.</p>
        )}
      </div>
      <div className="rail-box">
        <h3>
          Most read <small>by readers here, last 24h</small>
        </h3>
        {sidebar.mostRead.length ? (
          <ol>
            {sidebar.mostRead.map((m: any) => (
              <li key={m.card.id}>
                <Link to={`/story/${m.card.id}`} className="hl">{m.card.headline}</Link>
              </li>
            ))}
          </ol>
        ) : (
          <p className="meta">Popularity is measured from what readers of this edition open. Nothing has been read yet today.</p>
        )}
      </div>
      <div className="rail-box">
        <h3>What to watch</h3>
        {sidebar.upcoming.length ? (
          <ul>
            {sidebar.upcoming.map((e: any) => (
              <li key={e.id}>
                <div style={{ fontWeight: 600 }}>{e.title}</div>
                <div className="meta">
                  {fmtDateTime(e.starts_at)} ({until(e.starts_at)}) · <span className="badge neutral">{e.certainty}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="meta">No upcoming events with confirmed dates. Events are extracted from coverage when AI is configured, or added by you in Quick Reads.</p>
        )}
      </div>
      <div className="rail-box">
        <h3>
          Recently updated <small>latest meaningful change</small>
        </h3>
        <ul>
          {sidebar.recentlyUpdated.map((s: any) => (
            <li key={s.id}>
              <Link to={`/story/${s.id}`} className="hl">{s.headline}</Link>
              <div className="meta">{ago(s.lastUpdateAt)}</div>
            </li>
          ))}
        </ul>
      </div>
      <div className="rail-box">
        <h3>Your topics</h3>
        {sidebar.followedTopics.length ? (
          <ul>
            {sidebar.followedTopics.map((t: any) => (
              <li key={t.id} style={{ display: "flex", justifyContent: "space-between" }}>
                <Link to={`/topics/${t.id}`}>{t.name}</Link>
                <span className="meta">{t.count} stories</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="meta">
            <Link to="/topics">Follow topics</Link> to track subjects you care about.
          </p>
        )}
      </div>
    </aside>
  );
}

export { ConfigNotice };
