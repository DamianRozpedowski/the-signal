import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useApp } from "../lib/app";
import { ago, fmtLongDate } from "../lib/format";
import { Icon } from "./ui";

export const NAV_ITEMS: Record<string, { label: string; to: string; icon: string }> = {
  today: { label: "Today", to: "/", icon: "today" },
  "quick-reads": { label: "Quick Reads", to: "/quick-reads", icon: "quick" },
  live: { label: "Live News", to: "/live", icon: "live" },
  world: { label: "World", to: "/section/world", icon: "world" },
  us: { label: "U.S. News", to: "/section/us", icon: "us" },
  politics: { label: "Politics & Policy", to: "/section/politics", icon: "politics" },
  business: { label: "Business & Economy", to: "/section/business", icon: "business" },
  technology: { label: "Technology & AI", to: "/section/technology", icon: "technology" },
  science: { label: "Science & Health", to: "/section/science", icon: "science" },
  local: { label: "Local News", to: "/section/local", icon: "local" },
  topics: { label: "Topics", to: "/topics", icon: "topics" },
  saved: { label: "Saved", to: "/saved", icon: "saved" },
  archive: { label: "Archive", to: "/archive", icon: "archive" },
  sources: { label: "Sources", to: "/sources", icon: "sources" },
  settings: { label: "Settings", to: "/settings", icon: "settings" },
};

function Notifications() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<any>(null);
  const { unread, setUnread, toast } = useApp();
  const ref = useRef<HTMLDivElement>(null);
  const load = () => api.get("/api/notifications").then((d) => {
    setData(d);
    setUnread(d.unread);
  });
  useEffect(() => {
    if (open) load().catch((e) => toast(e.message, "error"));
  }, [open]);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, []);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button className="icon-btn" aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="bell" />
        {unread > 0 && <span className="badge-count">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && (
        <div className="popover" role="dialog" aria-label="Notifications">
          <header>
            <span>Notifications</span>
            <span style={{ display: "flex", gap: 6 }}>
              <button
                className="btn sm ghost"
                onClick={async () => {
                  await api.post("/api/notifications/read-all");
                  load();
                }}
              >
                Mark all read
              </button>
              <Link className="btn sm ghost" to="/settings#notifications" onClick={() => setOpen(false)}>
                Settings
              </Link>
            </span>
          </header>
          {!data && <div className="notif">Loading…</div>}
          {data && !data.items.length && <div className="notif b">No notifications yet. Alerts you enable in Settings will appear here.</div>}
          {data?.items.map((n: any) => (
            <Link
              key={n.id}
              to={n.url}
              className={`notif ${n.read_at ? "" : "unread"}`}
              onClick={() => {
                api.post(`/api/notifications/${n.id}/read`);
                setOpen(false);
              }}
            >
              <div className="t">{n.title}</div>
              <div className="b">{n.body}</div>
              <div className="b">
                {ago(n.created_at)}
                {n.held_reason && ` · held (${n.held_reason === "quiet_hours" ? "quiet hours" : "frequency limit"})`}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function RefreshStatus() {
  const { status, liveConnected } = useApp();
  const h = status?.health;
  const last = status?.refresh?.lastSuccessAt;
  const failing = h?.failing?.length ?? 0;
  const cls = !h ? "" : !h.total ? "warn" : failing && failing >= h.total / 2 ? "err" : failing ? "warn" : "ok";
  const title = !h
    ? "Checking sources…"
    : `${h.ok} of ${h.total} sources healthy${failing ? `; ${failing} failing` : ""}${h.pending ? `; ${h.pending} not fetched yet` : ""}. ${liveConnected ? "Live updates connected." : "Live updates disconnected."}`;
  return (
    <Link to="/sources" className="status-pill" title={title} aria-label={title}>
      <span className={`dot ${cls}`} />
      <span className="label">{last ? `Updated ${ago(last)}` : "No data yet"}</span>
      {failing > 0 && <span className="label">· {failing} failing</span>}
    </Link>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { session, prefs } = useApp();
  const [menuOpen, setMenuOpen] = useState(false);
  const [q, setQ] = useState("");
  const nav = useNavigate();
  const loc = useLocation();
  useEffect(() => setMenuOpen(false), [loc.pathname]);
  useEffect(() => {
    // Keyboard: "/" focuses search.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && !(e.target as HTMLElement)?.closest("input, textarea, select")) {
        e.preventDefault();
        document.getElementById("global-search")?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const order: string[] = prefs?.nav?.order ?? Object.keys(NAV_ITEMS);
  const hidden = new Set<string>(prefs?.nav?.hidden ?? []);
  const items = order.filter((k) => NAV_ITEMS[k] && !hidden.has(k));
  if (!items.includes("settings")) items.push("settings");

  return (
    <div className="shell">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      {menuOpen && <div className="scrim" onClick={() => setMenuOpen(false)} />}
      <aside className={`sidebar ${menuOpen ? "open" : ""}`} aria-label="Primary">
        <Link to="/" className="brand" style={{ textDecoration: "none" }}>
          The Signal
          <small>Your newspaper, always current</small>
        </Link>
        <nav className="nav">
          {items.map((k) => (
            <NavLink key={k} to={NAV_ITEMS[k].to} end={k === "today"} className={({ isActive }) => (isActive ? "active" : "")}>
              <Icon name={NAV_ITEMS[k].icon} />
              {NAV_ITEMS[k].label}
            </NavLink>
          ))}
          {session?.user?.isAdmin && (
            <>
              <div className="nav-sep" />
              <NavLink to="/admin" className={({ isActive }) => (isActive ? "active" : "")}>
                <Icon name="admin" />
                Admin
              </NavLink>
            </>
          )}
        </nav>
        <div className="sidebar-foot">
          <span>Signed in as {session?.user?.display_name}</span>
          <Link to="/settings#navigation">Customize navigation</Link>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="icon-btn menu-btn" aria-label="Open navigation" onClick={() => setMenuOpen(true)}>
            <Icon name="menu" />
          </button>
          <span className="date">{fmtLongDate()}</span>
          <form
            className="search-box"
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              if (q.trim()) nav(`/search?q=${encodeURIComponent(q.trim())}`);
            }}
          >
            <Icon name="search" size={16} />
            <label htmlFor="global-search" className="sr-only">
              Search the news
            </label>
            <input id="global-search" type="search" placeholder="Search stories, sources, topics…  ( / )" value={q} onChange={(e) => setQ(e.target.value)} />
          </form>
          <div className="topbar-right">
            <RefreshStatus />
            <Notifications />
            <Link to="/settings" className="icon-btn" aria-label="Account and settings">
              <Icon name="user" />
            </Link>
          </div>
        </header>
        <main id="main" tabIndex={-1}>
          {children}
        </main>
      </div>
      <nav className="mobile-tabs" aria-label="Quick navigation">
        {["today", "quick-reads", "live", "saved"].map((k) => (
          <NavLink key={k} to={NAV_ITEMS[k].to} end={k === "today"} className={({ isActive }) => (isActive ? "active" : "")}>
            <Icon name={NAV_ITEMS[k].icon} />
            {NAV_ITEMS[k].label.replace(" News", "")}
          </NavLink>
        ))}
        <a href="#" onClick={(e) => (e.preventDefault(), setMenuOpen(true))}>
          <Icon name="menu" />
          More
        </a>
      </nav>
    </div>
  );
}
