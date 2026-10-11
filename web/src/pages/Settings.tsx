import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { NAV_ITEMS } from "../components/Layout";
import { api } from "../lib/api";
import { useApp } from "../lib/app";
import { Icon, Toggle } from "../components/ui";

function Row({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center", padding: "10px 0", borderBottom: "1px solid var(--rule)", flexWrap: "wrap" }}>
      <div style={{ flex: "1 1 260px" }}>
        {htmlFor ? <label htmlFor={htmlFor} style={{ fontWeight: 600 }}>{label}</label> : <div style={{ fontWeight: 600 }}>{label}</div>}
        {hint && <div className="meta" style={{ marginTop: 2 }}>{hint}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

const TYPE_LABELS: Record<string, [string, string]> = {
  breaking: ["Breaking news", "Major, corroborated developments."],
  followed_story: ["Followed stories", "Meaningful updates to stories you follow."],
  topic: ["Followed topics", "Important new stories on topics you follow."],
  keyword: ["Keyword alerts", "New articles matching your keywords and saved searches with alerts on."],
  source: ["Source alerts", "New articles from sources you pick below."],
  upcoming: ["Upcoming events", "Reminders before events on your watch list."],
  briefing: ["New briefing", "When a new Quick Reads edition is ready."],
};

function urlB64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export function Settings() {
  const { prefs, savePrefs, session, reloadSession, status, toast } = useApp();
  const [sources, setSources] = useState<any[]>([]);
  useEffect(() => {
    api.get("/api/sources").then((r) => setSources(r.sources.filter((s: any) => s.enabled))).catch(() => undefined);
  }, []);
  if (!prefs) return null;
  const save = (patch: any, msg = "Saved") => savePrefs(patch).then(() => toast(msg)).catch((e) => toast(e.message, "error"));
  const n = prefs.notifications;
  const ch = status?.notificationChannels ?? {};

  return (
    <div className="page" style={{ maxWidth: 860 }}>
      <h1 className="hl hl-l">Settings</h1>
      <nav className="chips" aria-label="Settings sections" style={{ marginBottom: 18 }}>
        {[["appearance", "Appearance"], ["navigation", "Navigation"], ["personalization", "Personalization"], ["briefing", "Quick Reads"], ["notifications", "Notifications"], ["account", "Account"]].map(([id, l]) => (
          <a key={id} className="chip" href={`#${id}`}>{l}</a>
        ))}
      </nav>

      <section id="appearance" className="panel">
        <h2>Appearance</h2>
        <Row label="Theme">
          <div className="seg" role="group" aria-label="Theme">
            {["system", "light", "dark"].map((t) => (
              <button key={t} className={prefs.theme === t ? "on" : ""} aria-pressed={prefs.theme === t} onClick={() => save({ theme: t }, "Theme updated")}>{t[0].toUpperCase() + t.slice(1)}</button>
            ))}
          </div>
        </Row>
        <Row label="Text size">
          <div className="seg" role="group" aria-label="Text size">
            {[["sm", "Small"], ["md", "Default"], ["lg", "Large"], ["xl", "Extra large"]].map(([k, l]) => (
              <button key={k} className={prefs.textSize === k ? "on" : ""} aria-pressed={prefs.textSize === k} onClick={() => save({ textSize: k }, "Text size updated")}>{l}</button>
            ))}
          </div>
        </Row>
        <Row label="Story cards" hint="Compact shows more headlines with less detail.">
          <div className="seg" role="group" aria-label="Density">
            {["expanded", "compact"].map((d) => (
              <button key={d} className={prefs.density === d ? "on" : ""} onClick={() => save({ density: d })}>{d[0].toUpperCase() + d.slice(1)}</button>
            ))}
          </div>
        </Row>
        <Row label="Live updates" hint="How pages refresh when new stories arrive.">
          <select aria-label="Live updates" value={prefs.liveUpdates} onChange={(e) => save({ liveUpdates: e.target.value })}>
            <option value="realtime">As they happen</option>
            <option value="every5">At most every 5 minutes</option>
            <option value="manual">Only when I choose</option>
          </select>
        </Row>
        <p className="meta">The front page layout is edited directly on <Link to="/">Today</Link> with “Edit layout”.</p>
      </section>

      <NavEditor />

      <section id="personalization" className="panel">
        <h2>Personalization</h2>
        <Row label="Personalization strength" htmlFor="pers" hint="Low keeps a broad editorial front page; high favors your followed topics, area and preferred sources. Major stories are always included.">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="meta">Broad</span>
            <input id="pers" type="range" min={0} max={100} step={5} defaultValue={prefs.personalization} onMouseUp={(e) => save({ personalization: Number((e.target as HTMLInputElement).value) })} onKeyUp={(e) => save({ personalization: Number((e.target as HTMLInputElement).value) })} onTouchEnd={(e) => save({ personalization: Number((e.target as HTMLInputElement).value) })} />
            <span className="meta">Personal</span>
          </div>
        </Row>
        <Row label="Local area" hint={prefs.location ? prefs.location.label : "Not set"}>
          <Link className="btn sm" to="/">Change on Today → Edit layout</Link>
        </Row>
        <Row label="Topics" hint="Follow or mute topics, or create your own."><Link className="btn sm" to="/topics">Manage topics</Link></Row>
        <Row label="Sources" hint="Choose publishers and set their priority."><Link className="btn sm" to="/sources">Manage sources</Link></Row>
      </section>

      <section id="briefing" className="panel">
        <h2>Quick Reads</h2>
        <Row label="Default reading length">
          <div className="seg" role="group" aria-label="Default length">
            {[2, 5, 10].map((m) => (
              <button key={m} className={prefs.briefing.defaultLength === m ? "on" : ""} onClick={() => save({ briefing: { defaultLength: m } })}>{m} min</button>
            ))}
          </div>
        </Row>
        <Row label="Morning edition starts at" htmlFor="mc" hint="In your time zone.">
          <input id="mc" type="time" defaultValue={prefs.briefing.morningCutoff} onBlur={(e) => e.target.value && save({ briefing: { morningCutoff: e.target.value } })} />
        </Row>
        <Row label="Evening edition starts at" htmlFor="ec">
          <input id="ec" type="time" defaultValue={prefs.briefing.eveningCutoff} onBlur={(e) => e.target.value && save({ briefing: { eveningCutoff: e.target.value } })} />
        </Row>
        <Row label="Overnight section covers news since" htmlFor="on" hint="The previous evening, until the morning edition.">
          <input id="on" type="time" defaultValue={prefs.briefing.overnightFrom} onBlur={(e) => e.target.value && save({ briefing: { overnightFrom: e.target.value } })} />
        </Row>
      </section>

      <section id="notifications" className="panel">
        <h2>Notifications</h2>
        <Row label="Notifications" hint="Turn all alerts on or off.">
          <Toggle label="Notifications enabled" checked={n.enabled} onChange={(v) => save({ notifications: { enabled: v } })} />
        </Row>
        <h3 style={{ marginTop: 16 }}>What to alert me about</h3>
        {Object.entries(TYPE_LABELS).map(([k, [l, h]]) => (
          <Row key={k} label={l} hint={h}>
            <Toggle label={l} checked={n.types[k]} onChange={(v) => save({ notifications: { types: { [k]: v } } })} />
          </Row>
        ))}
        <Row label="Only alert me for" htmlFor="minp">
          <select id="minp" value={n.minPriority} onChange={(e) => save({ notifications: { minPriority: Number(e.target.value) } })}>
            <option value={1}>Everything I subscribed to</option>
            <option value={2}>Notable updates and above</option>
            <option value={3}>Only the most important</option>
          </select>
        </Row>
        <KeywordEditor keywords={n.keywords} onSave={(k) => save({ notifications: { keywords: k } }, "Keywords saved")} />
        {n.types.source && (
          <Row label="Source alerts" hint="New articles from these sources will notify you.">
            <select
              multiple
              aria-label="Sources to alert on"
              value={n.alertSourceIds.map(String)}
              onChange={(e) => save({ notifications: { alertSourceIds: [...e.target.selectedOptions].map((o) => Number(o.value)) } })}
              style={{ minHeight: 120, minWidth: 240 }}
            >
              {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Row>
        )}

        <h3 style={{ marginTop: 16 }}>Where to deliver them</h3>
        <Row label="In the app" hint="The bell in the top bar.">
          <Toggle label="In-app notifications" checked={n.channels.in_app} onChange={(v) => save({ notifications: { channels: { in_app: v } } })} />
        </Row>
        <Row
          label="Browser notifications"
          hint={
            typeof Notification === "undefined"
              ? "This browser does not support notifications."
              : Notification.permission === "denied"
                ? "Blocked in your browser settings for this site."
                : ch.browser?.detail
          }
        >
          <Toggle
            label="Browser notifications"
            checked={n.channels.browser}
            onChange={async (v) => {
              if (v && typeof Notification !== "undefined" && Notification.permission !== "granted") {
                const p = await Notification.requestPermission();
                if (p !== "granted") return toast("Browser permission was not granted", "error");
              }
              save({ notifications: { channels: { browser: v } } });
            }}
          />
        </Row>
        <Row label="Email" hint={ch.email?.available ? `${ch.email.detail} To ${session?.user?.email}.` : <span style={{ color: "var(--warn)" }}>Not available: {ch.email?.detail}</span>}>
          <Toggle label="Email notifications" disabled={!ch.email?.available && !n.channels.email} checked={n.channels.email} onChange={(v) => save({ notifications: { channels: { email: v } } })} />
        </Row>
        <Row label="Push (mobile and desktop)" hint={ch.push?.available ? ch.push.detail : <span style={{ color: "var(--warn)" }}>Not available: {ch.push?.detail}</span>}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {ch.push?.available && (
              <button
                className="btn sm"
                onClick={async () => {
                  try {
                    if (!("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("This browser does not support push notifications.");
                    const reg = await navigator.serviceWorker.register("/sw.js");
                    const perm = await Notification.requestPermission();
                    if (perm !== "granted") throw new Error("Notification permission was not granted.");
                    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(ch.push.publicKey) });
                    await api.post("/api/push/subscribe", sub.toJSON());
                    await savePrefs({ notifications: { channels: { push: true } } });
                    toast("This device will receive push notifications");
                  } catch (e: any) {
                    toast(e.message, "error");
                  }
                }}
              >
                Subscribe this device
              </button>
            )}
            <Toggle label="Push notifications" disabled={!ch.push?.available && !n.channels.push} checked={n.channels.push} onChange={(v) => save({ notifications: { channels: { push: v } } })} />
          </div>
        </Row>

        <h3 style={{ marginTop: 16 }}>Limits</h3>
        <Row label="Quiet hours" hint={`Alerts are held (still visible in the app) between ${n.quietHours.start} and ${n.quietHours.end}, ${session?.user?.timezone}.`}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="time" aria-label="Quiet hours start" defaultValue={n.quietHours.start} onBlur={(e) => e.target.value && save({ notifications: { quietHours: { start: e.target.value } } })} />
            <span>–</span>
            <input type="time" aria-label="Quiet hours end" defaultValue={n.quietHours.end} onBlur={(e) => e.target.value && save({ notifications: { quietHours: { end: e.target.value } } })} />
            <Toggle label="Quiet hours enabled" checked={n.quietHours.enabled} onChange={(v) => save({ notifications: { quietHours: { enabled: v } } })} />
          </div>
        </Row>
        <Row label="Maximum alerts per hour" htmlFor="mph" hint="The most important breaking alerts can exceed this.">
          <input id="mph" type="number" min={1} max={60} defaultValue={n.maxPerHour} onBlur={(e) => save({ notifications: { maxPerHour: Number(e.target.value) } })} style={{ width: 80 }} />
        </Row>
        <div style={{ marginTop: 14 }}>
          <button
            className="btn"
            onClick={async () => {
              try {
                const r = await api.post("/api/notifications/test");
                if (!r.id) return toast("No test sent: notifications are turned off", "error");
                const summary = r.deliveries.map((d: any) => `${d.channel.replace("_", "-")}: ${d.status.replace("_", " ")}${d.error ? ` (${d.error})` : ""}`).join("; ");
                toast(`Test notification: ${summary}`);
              } catch (e: any) {
                toast(e.message, "error");
              }
            }}
          >
            <Icon name="bell" size={15} /> Send a test notification
          </button>
          <span className="meta" style={{ marginLeft: 10 }}>Shows exactly which channels delivered it.</span>
        </div>
      </section>

      <Account session={session} reloadSession={reloadSession} toast={toast} />
    </div>
  );
}

function KeywordEditor({ keywords, onSave }: { keywords: string[]; onSave: (k: string[]) => void }) {
  const [v, setV] = useState("");
  return (
    <Row label="Keyword alerts" hint={keywords.length ? undefined : "No keywords yet."}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
        <div className="chips">
          {keywords.map((k) => (
            <button key={k} className="chip" onClick={() => onSave(keywords.filter((x) => x !== k))} aria-label={`Remove keyword ${k}`}>{k} ×</button>
          ))}
        </div>
        <form
          style={{ display: "flex", gap: 6 }}
          onSubmit={(e) => {
            e.preventDefault();
            const k = v.trim();
            if (k && !keywords.includes(k)) onSave([...keywords, k]);
            setV("");
          }}
        >
          <input type="text" aria-label="New keyword" placeholder="Add keyword" value={v} onChange={(e) => setV(e.target.value)} maxLength={60} />
          <button className="btn sm">Add</button>
        </form>
      </div>
    </Row>
  );
}

function NavEditor() {
  const { prefs, savePrefs, toast } = useApp();
  const [order, setOrder] = useState<string[]>(prefs.nav.order);
  const [hidden, setHidden] = useState<string[]>(prefs.nav.hidden);
  const dirty = JSON.stringify(order) !== JSON.stringify(prefs.nav.order) || JSON.stringify(hidden) !== JSON.stringify(prefs.nav.hidden);
  const move = (i: number, d: number) => {
    const o = [...order];
    const j = i + d;
    if (j < 0 || j >= o.length) return;
    [o[i], o[j]] = [o[j], o[i]];
    setOrder(o);
  };
  return (
    <section id="navigation" className="panel">
      <h2>Navigation</h2>
      <p className="meta" style={{ marginTop: 0 }}>Reorder or hide sections in the sidebar. Settings always stays visible.</p>
      <div className="table-wrap">
        <table className="data">
          <tbody>
            {order.map((k, i) => (
              <tr key={k}>
                <td style={{ width: 70 }}>
                  <button className="icon-btn" style={{ width: 28, height: 28 }} aria-label={`Move ${NAV_ITEMS[k]?.label} up`} onClick={() => move(i, -1)}><Icon name="up" size={14} /></button>
                  <button className="icon-btn" style={{ width: 28, height: 28 }} aria-label={`Move ${NAV_ITEMS[k]?.label} down`} onClick={() => move(i, 1)}><Icon name="down" size={14} /></button>
                </td>
                <td><Icon name={NAV_ITEMS[k]?.icon ?? "topics"} size={15} /> {NAV_ITEMS[k]?.label ?? k}</td>
                <td style={{ width: 90 }}>
                  {k !== "settings" && (
                    <label className="check">
                      <input type="checkbox" checked={!hidden.includes(k)} onChange={(e) => setHidden(e.target.checked ? hidden.filter((x) => x !== k) : [...hidden, k])} /> Show
                    </label>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button className="btn primary" disabled={!dirty} onClick={() => savePrefs({ nav: { order, hidden } }).then(() => toast("Navigation saved"))}>Save navigation</button>
        <button
          className="btn ghost"
          onClick={async () => {
            const r = await api.get("/api/prefs");
            setOrder(r.defaults.nav.order);
            setHidden(r.defaults.nav.hidden);
          }}
        >
          Restore default order
        </button>
      </div>
    </section>
  );
}

function Account({ session, reloadSession, toast }: any) {
  const u = session.user;
  const [name, setName] = useState(u.display_name);
  const [tz, setTz] = useState(u.timezone);
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const zones: string[] = (Intl as any).supportedValuesOf ? (Intl as any).supportedValuesOf("timeZone") : [u.timezone];
  return (
    <section id="account" className="panel">
      <h2>Account</h2>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.patch("/api/account", { displayName: name, timezone: tz });
            await reloadSession();
            toast("Account updated");
          } catch (err: any) {
            toast(err.message, "error");
          }
        }}
      >
        <div className="grid-2">
          <div className="field">
            <label htmlFor="acc-name">Display name</label>
            <input id="acc-name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="acc-tz">Time zone</label>
            <select id="acc-tz" value={tz} onChange={(e) => setTz(e.target.value)}>
              {(zones.includes(tz) ? zones : [tz, ...zones]).map((z) => <option key={z} value={z}>{z}</option>)}
            </select>
            <span className="hint">Used for edition times, quiet hours and dates.</span>
          </div>
        </div>
        <p className="meta">Signed in as {u.email}{u.isAdmin ? " (administrator)" : ""}.</p>
        <button className="btn primary">Save account</button>
      </form>

      <h3 style={{ marginTop: 20 }}>Change password</h3>
      <form
        className="toolbar"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.post("/api/account/password", { current: cur, next });
            setCur("");
            setNext("");
            toast("Password changed; other devices were signed out");
          } catch (err: any) {
            toast(err.message, "error");
          }
        }}
      >
        <input type="password" aria-label="Current password" placeholder="Current password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required />
        <input type="password" aria-label="New password" placeholder="New password (10+ characters)" autoComplete="new-password" minLength={10} value={next} onChange={(e) => setNext(e.target.value)} required />
        <button className="btn">Change password</button>
      </form>

      <h3 style={{ marginTop: 20 }}>Your data</h3>
      <div className="toolbar">
        <a className="btn" href="/api/account/export" download>Export my data (JSON)</a>
        <button
          className="btn"
          onClick={async () => {
            if (!window.confirm("Reset all preferences (layout, navigation, notifications) to defaults? Sources, topics and saved items are kept.")) return;
            await api.post("/api/prefs/reset");
            await reloadSession();
            toast("Preferences reset");
          }}
        >
          Reset preferences
        </button>
        <button
          className="btn"
          onClick={async () => {
            await api.post("/api/auth/logout");
            await reloadSession();
          }}
        >
          Sign out
        </button>
        <button
          className="btn danger"
          onClick={async () => {
            const pw = window.prompt("This permanently deletes your account, saved items, history and custom sources. Enter your password to confirm.");
            if (!pw) return;
            try {
              await api.del("/api/account", { password: pw });
              await reloadSession();
            } catch (err: any) {
              toast(err.message, "error");
            }
          }}
        >
          Delete account
        </button>
      </div>
    </section>
  );
}
