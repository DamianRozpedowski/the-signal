import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useApp } from "../lib/app";
import { ago, fmtDateTime, safeHref } from "../lib/format";

// ---- Icons (inline, decorative; labels come from surrounding text/aria) -------------
const paths: Record<string, string> = {
  today: "M4 5h16v14H4zM4 9h16M9 9v10",
  quick: "M13 2 4 14h7l-1 8 9-12h-7z",
  live: "M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M6.3 6.3a8 8 0 0 0 0 11.4M17.7 6.3a8 8 0 0 1 0 11.4M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7",
  world: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18",
  us: "M4 4h16v16H4zM8 9h8M8 13h8M8 17h5",
  politics: "M3 21h18M5 21V10M19 21V10M9 21V10M15 21V10M2 10l10-6 10 6z",
  business: "M3 20h18M6 16l4-5 3 3 5-7",
  technology: "M5 5h14v10H5zM2 19h20M9 15v4M15 15v4",
  science: "M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3",
  local: "M12 21s-7-6.5-7-11a7 7 0 1 1 14 0c0 4.5-7 11-7 11zM12 10m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0",
  topics: "M4 7h16M4 12h16M4 17h10",
  saved: "M6 3h12v18l-6-4-6 4z",
  archive: "M3 5h18v4H3zM5 9v10h14V9M10 13h4",
  sources: "M4 6h16M4 12h16M4 18h16M7 4v4M12 10v4M17 16v4",
  settings: "M12 15a3 3 0 1 0 0-6a3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  search: "M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14M21 21l-5-5",
  bell: "M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21a2 2 0 0 0 4 0",
  menu: "M3 6h18M3 12h18M3 18h18",
  admin: "M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z",
  external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  bookmark: "M6 3h12v18l-6-4-6 4z",
  check: "M4 12l5 5L20 6",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  user: "M12 12a4 4 0 1 0 0-8a4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  close: "M6 6l12 12M18 6L6 18",
  up: "M12 19V5M5 12l7-7 7 7",
  down: "M12 5v14M5 12l7 7 7-7",
  ask: "M8 9a4 4 0 1 1 5.5 3.7c-.9.4-1.5 1.2-1.5 2.1V16M12 20h.01",
};
export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name] ?? paths.topics} />
    </svg>
  );
}

// ---- States --------------------------------------------------------------------------
export function Loading({ lines = 4 }: { lines?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="skeleton" style={{ height: i === 0 ? 28 : 14, width: `${i === 0 ? 70 : 92 - i * 7}%`, marginBottom: 12 }} />
      ))}
    </div>
  );
}
export function ErrorState({ error, retry }: { error: string; retry?: () => void }) {
  return (
    <div className="notice error" role="alert">
      <div>
        <strong>Something went wrong</strong>
        {error}
      </div>
      {retry && (
        <button className="btn sm" onClick={retry} style={{ marginLeft: "auto" }}>
          Retry
        </button>
      )}
    </div>
  );
}
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <div>{children}</div>
    </div>
  );
}

/** Honest configuration notice: shown when a feature needs a server-side credential. */
export function ConfigNotice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="notice config" role="note">
      <div>
        <strong>{title}</strong>
        {children}
      </div>
    </div>
  );
}

// ---- Story metadata -------------------------------------------------------------------
export function StoryBadges({ s }: { s: any }) {
  return (
    <>
      {s.isBreaking && <span className="badge breaking">Breaking</span>}
      {s.status === "developing" && <span className="badge developing">Developing</span>}
      {s.lead?.articleType === "opinion" && <span className="badge opinion">Opinion</span>}
      {s.lead?.articleType === "analysis" && <span className="badge opinion">Analysis</span>}
      {s.hasOfficial && <span className="badge official">Official source</span>}
    </>
  );
}

export function StoryMeta({ s, showCategory = true }: { s: any; showCategory?: boolean }) {
  const updated = s.lastUpdateAt && Date.parse(s.lastUpdateAt) - Date.parse(s.firstPublishedAt) > 10 * 60_000;
  return (
    <div className="meta">
      <span className="src">{s.lead.sourceName}</span>
      {s.sourceCount > 1 && <span>+{s.sourceCount - 1} more source{s.sourceCount > 2 ? "s" : ""}</span>}
      {showCategory && <span>{s.categoryLabel}</span>}
      <span title={`Published ${fmtDateTime(s.firstPublishedAt)}`}>Published {ago(s.firstPublishedAt)}</span>
      {updated && <span title={`Last meaningful update ${fmtDateTime(s.lastUpdateAt)}`}>Updated {ago(s.lastUpdateAt)}</span>}
    </div>
  );
}

function Thumb({ src, className = "thumb", alt = "" }: { src?: string | null; className?: string; alt?: string }) {
  const [ok, setOk] = useState(true);
  const href = safeHref(src);
  if (!href || !ok) return null;
  return <img className={className} src={href} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setOk(false)} />;
}

export function StoryCard({ s, variant = "standard", showImage = true, showReasons = false }: { s: any; variant?: "standard" | "compact" | "row" | "headline"; showImage?: boolean; showReasons?: boolean }) {
  const why = s.reasons?.filter((r: any) => r.points > 0).slice(0, 2).map((r: any) => r.label).join(" · ");
  if (variant === "headline") {
    return (
      <div className="card">
        <div className="badges">
          <StoryBadges s={s} />
        </div>
        <Link to={`/story/${s.id}`}>
          <h3 className="hl hl-s">{s.headline}</h3>
        </Link>
        <StoryMeta s={s} showCategory={false} />
      </div>
    );
  }
  if (variant === "row") {
    return (
      <div className="card">
        <div className="row">
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            <div className="badges">
              <span className="kicker">{s.categoryLabel}</span>
              <StoryBadges s={s} />
            </div>
            <Link to={`/story/${s.id}`}>
              <h3 className="hl hl-m">{s.headline}</h3>
            </Link>
            {s.description && <p className="dek" style={{ fontSize: "0.95rem" }}>{truncate(s.summary ?? s.description, 200)}</p>}
            <StoryMeta s={s} showCategory={false} />
            {s.personalReasons?.length > 0 && <div className="personal">{s.personalReasons.join(" · ")}</div>}
          </div>
          {showImage && <Thumb src={s.lead.imageUrl} />}
        </div>
      </div>
    );
  }
  return (
    <div className="card">
      {showImage && variant === "standard" && <Thumb src={s.lead.imageUrl} />}
      <div className="badges">
        <span className="kicker">{s.categoryLabel}</span>
        <StoryBadges s={s} />
      </div>
      <Link to={`/story/${s.id}`}>
        <h3 className={`hl ${variant === "compact" ? "hl-s" : "hl-m"}`}>{s.headline}</h3>
      </Link>
      {variant === "standard" && (s.summary || s.description) && <p className="dek" style={{ fontSize: "0.95rem" }}>{truncate(s.summary ?? s.description, 180)}</p>}
      <StoryMeta s={s} showCategory={false} />
      {s.personalReasons?.length > 0 && <div className="personal">{s.personalReasons.join(" · ")}</div>}
      {showReasons && why && <div className="reasons">Why it's here: {why}</div>}
    </div>
  );
}

export function truncate(s: string, n: number) {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n).replace(/\s+\S*$/, "")}…` : s;
}

// ---- Save / follow ------------------------------------------------------------------
export function SaveButton({ type, id, list = "saved", initial, labels }: { type: "article" | "story" | "briefing"; id: number; list?: string; initial: boolean; labels?: [string, string] }) {
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  const { toast } = useApp();
  const [offLabel, onLabel] = labels ?? ["Save", "Saved"];
  return (
    <button
      className={`btn sm ${on ? "on" : ""}`}
      aria-pressed={on}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          if (on) await api.del("/api/saved", { targetType: type, targetId: id, list });
          else await api.post("/api/saved", { targetType: type, targetId: id, list });
          setOn(!on);
          toast(on ? `Removed from ${list === "saved" ? "Saved" : list === "later" ? "Read later" : list}` : `Added to ${list === "saved" ? "Saved" : list === "later" ? "Read later" : list === "following" ? "followed stories" : list}`);
        } catch (e: any) {
          toast(e.message, "error");
        } finally {
          setBusy(false);
        }
      }}
    >
      <Icon name={list === "following" ? "bell" : "bookmark"} size={15} />
      {on ? onLabel : offLabel}
    </button>
  );
}

export function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  const h = safeHref(href);
  if (!h) return <span className={className}>{children}</span>;
  return (
    <a href={h} target="_blank" rel="noopener noreferrer nofollow" className={className}>
      {children}
    </a>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <span className="toggle" style={disabled ? { opacity: 0.45 } : undefined}>
      <input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </span>
  );
}

export function SourceStatus({ status, error }: { status: string; error?: string | null }) {
  const map: Record<string, [string, string]> = {
    ok: ["ok", "Healthy"],
    degraded: ["warn", "Retrying"],
    error: ["err", "Failing"],
    pending: ["neutral", "Not fetched yet"],
    disabled: ["neutral", "Disabled by admin"],
  };
  const [cls, label] = map[status] ?? ["neutral", status];
  return (
    <span className={`badge ${cls}`} title={error ?? undefined}>
      {label}
    </span>
  );
}
