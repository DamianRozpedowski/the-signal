import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { qs } from "../lib/api";
import { useApp, useLoad } from "../lib/app";
import { Empty, ErrorState, Loading, StoryCard } from "../components/ui";
import { LOCATIONS } from "./Today";

export function Section() {
  const { key = "" } = useParams();
  const { prefs } = useApp();
  const [sort, setSort] = useState("importance");
  const [hours, setHours] = useState(72);
  const [source, setSource] = useState("");
  const [developing, setDeveloping] = useState(false);
  const [geo, setGeo] = useState("");
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [key, sort, hours, source, developing, geo]);
  const url = `/api/category/${key}${qs({ sort, hours, source, status: developing ? "developing" : "", geo, page })}`;
  const { data, error, loading, reload } = useLoad<any>(url, { liveOn: ["cluster"] });
  const compact = prefs?.density === "compact";
  const pages = data ? Math.ceil(data.total / data.pageSize) : 1;

  return (
    <div className={`page ${compact ? "compact" : ""}`}>
      <h1 className="hl hl-l">{data?.label ?? "Section"}</h1>
      {key === "local" && (
        <p className="page-sub">
          {data?.location ? `Stories mentioning ${data.location.label} and from local outlets you follow.` : "Choose a coverage area to see stories about your region."}{" "}
          <Link to="/sources?category=local">Add local outlets</Link>
        </p>
      )}
      <div className="toolbar">
        <div className="seg" role="group" aria-label="Sort">
          <button className={sort === "importance" ? "on" : ""} onClick={() => setSort("importance")}>Most important</button>
          <button className={sort === "latest" ? "on" : ""} onClick={() => setSort("latest")}>Latest</button>
        </div>
        <label className="sr-only" htmlFor="sec-hours">Time range</label>
        <select id="sec-hours" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
          <option value={24}>Last 24 hours</option>
          <option value={72}>Last 3 days</option>
          <option value={168}>Last week</option>
          <option value={336}>Last 2 weeks</option>
        </select>
        <label className="sr-only" htmlFor="sec-src">Source</label>
        <select id="sec-src" value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">All my sources</option>
          {data?.sources?.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        {key === "local" && (
          <>
            <label className="sr-only" htmlFor="sec-geo">Area</label>
            <select id="sec-geo" value={geo} onChange={(e) => setGeo(e.target.value)}>
              <option value="">{prefs?.location ? `My area (${prefs.location.label})` : "Any area"}</option>
              {LOCATIONS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
          </>
        )}
        <label className="check">
          <input type="checkbox" checked={developing} onChange={(e) => setDeveloping(e.target.checked)} /> Developing only
        </label>
        <span className="grow" />
        {data && <span className="meta">{data.total} stories</span>}
      </div>
      {loading && !data && <Loading lines={8} />}
      {error && <ErrorState error={error} retry={() => reload()} />}
      {data && !data.stories.length && <Empty title="No stories match">Your sources have no stories in this section for the selected period.</Empty>}
      {data && data.stories.length > 0 && (
        <div className="list" style={{ maxWidth: 900 }}>
          {data.stories.map((s: any) => (
            <StoryCard key={s.id} s={s} variant="row" showImage={prefs?.homepage?.showImages !== false && !compact} showReasons />
          ))}
        </div>
      )}
      {pages > 1 && (
        <div className="toolbar" style={{ marginTop: 16 }}>
          <button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
          <span className="meta">Page {page} of {pages}</span>
          <button className="btn sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      )}
    </div>
  );
}
