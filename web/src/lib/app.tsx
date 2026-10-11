import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "./api";
import { setTimeZone } from "./format";
import { STATIC, watchEdition } from "./static";

// App-wide state: the signed-in user, their preferences, system status (AI, delivery
// channels, source health), live server events and toasts.

export interface Session {
  user: null | { id: number; email: string; display_name: string; isAdmin: boolean; timezone: string; language: string };
  prefs: any;
  setupRequired: boolean;
  signupAllowed: boolean;
}

interface Ctx {
  session: Session | null;
  reloadSession: () => Promise<void>;
  prefs: any;
  savePrefs: (patch: any) => Promise<void>;
  status: any;
  reloadStatus: () => void;
  toast: (msg: string, kind?: "info" | "error") => void;
  onLive: (fn: (type: string, data: any) => void) => () => void;
  liveConnected: boolean;
  unread: number;
  setUnread: (n: number) => void;
}

const AppCtx = createContext<Ctx>(null as any);
export const useApp = () => useContext(AppCtx);

export function AppProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<any>(null);
  const [toasts, setToasts] = useState<{ id: number; msg: string; kind: string }[]>([]);
  const [liveConnected, setLiveConnected] = useState(false);
  const [unread, setUnread] = useState(0);
  const listeners = useRef(new Set<(type: string, data: any) => void>());

  const reloadSession = useCallback(async () => {
    const s = await api.get<Session>("/api/session");
    setSession(s);
    setTimeZone(s.user?.timezone);
  }, []);

  const reloadStatus = useCallback(() => {
    api.get("/api/system/status").then(setStatus).catch(() => undefined);
  }, []);

  useEffect(() => {
    reloadSession().catch(() => setSession({ user: null, prefs: null, setupRequired: false, signupAllowed: false }));
  }, [reloadSession]);

  const toast = useCallback((msg: string, kind: "info" | "error" = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 7000 : 4000);
  }, []);

  const savePrefs = useCallback(
    async (patch: any) => {
      const r = await api.put<{ prefs: any }>("/api/prefs", patch);
      setSession((s) => (s ? { ...s, prefs: r.prefs } : s));
    },
    [],
  );

  // Apply appearance preferences.
  const prefs = session?.prefs;
  useEffect(() => {
    const root = document.documentElement;
    const theme = prefs?.theme ?? "system";
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
      root.dataset.theme = dark ? "dark" : "light";
    };
    apply();
    root.dataset.text = prefs?.textSize ?? "md";
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [prefs?.theme, prefs?.textSize]);

  // Live updates via Server-Sent Events (only while signed in).
  const userId = session?.user?.id;
  // Static edition: no server to stream from; check for a newly published edition instead.
  useEffect(() => {
    if (!STATIC || !userId) return;
    reloadStatus();
    setLiveConnected(true);
    return watchEdition(() => {
      reloadStatus();
      for (const t of ["refresh", "articles", "cluster", "briefing", "source"]) listeners.current.forEach((fn) => fn(t, null));
    });
  }, [userId, reloadStatus]);

  useEffect(() => {
    if (STATIC || !userId) return;
    reloadStatus();
    const es = new EventSource("/api/events");
    const fan = (type: string) => (ev: MessageEvent) => {
      let data: any = null;
      try {
        data = JSON.parse(ev.data);
      } catch {
        /* ignore */
      }
      if (type === "source") reloadStatus();
      if (type === "notification" && data) {
        setUnread((n) => n + 1);
        if (!data.held_reason && Notification?.permission === "granted" && prefs?.notifications?.channels?.browser && document.visibilityState !== "visible") {
          try {
            const n = new Notification(data.title, { body: data.body, icon: "/favicon.svg", tag: `dw-${data.id}` });
            n.onclick = () => {
              window.focus();
              window.location.assign(data.url);
            };
          } catch {
            /* not supported */
          }
        }
      }
      listeners.current.forEach((fn) => fn(type, data));
    };
    es.onopen = () => setLiveConnected(true);
    es.onerror = () => setLiveConnected(false);
    for (const t of ["articles", "cluster", "source", "briefing", "notification", "refresh"]) es.addEventListener(t, fan(t) as any);
    const statusTimer = setInterval(reloadStatus, 60_000);
    api.get("/api/notifications").then((r) => setUnread(r.unread)).catch(() => undefined);
    return () => {
      es.close();
      clearInterval(statusTimer);
      setLiveConnected(false);
    };
  }, [userId, reloadStatus, prefs?.notifications?.channels?.browser]);

  const onLive = useCallback((fn: (type: string, data: any) => void) => {
    listeners.current.add(fn);
    return () => listeners.current.delete(fn);
  }, []);

  const value = useMemo(
    () => ({ session, reloadSession, prefs, savePrefs, status, reloadStatus, toast, onLive, liveConnected, unread, setUnread }),
    [session, reloadSession, prefs, savePrefs, status, reloadStatus, toast, onLive, liveConnected, unread],
  );
  return (
    <AppCtx.Provider value={value}>
      {children}
      <div className="toast-wrap" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind === "error" ? "error" : ""}`}>
            {t.msg}
          </div>
        ))}
      </div>
    </AppCtx.Provider>
  );
}

/** Fetch helper with loading/error state and optional live refresh on server events. */
export function useLoad<T>(
  url: string | null,
  opts: {
    liveOn?: string[];
    deps?: unknown[];
    /** URL for live (quiet) refreshes, e.g. one that does not count as a new visit. */
    liveUrl?: string;
    /** Only refresh for events this returns true for (e.g. events about this story). */
    liveFilter?: (type: string, data: any) => boolean;
  } = {},
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { onLive, prefs } = useApp();
  const load = useCallback(
    (quiet = false) => {
      if (!url) return Promise.resolve();
      if (!quiet) setLoading(true);
      return api
        .get<T>(quiet && opts.liveUrl ? opts.liveUrl : url)
        .then((d) => {
          setData(d);
          setError(null);
        })
        .catch((e) => setError(e.message))
        .finally(() => setLoading(false));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [url, ...(opts.deps ?? [])],
  );
  useEffect(() => {
    load();
  }, [load]);
  const mode = prefs?.liveUpdates ?? "realtime";
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!opts.liveOn?.length || mode === "manual") return;
    let timer: any = null;
    const off = onLive((type, data) => {
      if (!opts.liveOn!.includes(type)) return;
      if (opts.liveFilter && !opts.liveFilter(type, data)) return;
      if (mode === "every5") {
        setPending(true);
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => load(true), 1200); // debounce bursts of events
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [onLive, load, mode, opts.liveOn?.join(",")]);
  useEffect(() => {
    if (mode !== "every5" || !opts.liveOn?.length) return;
    const t = setInterval(() => {
      setPending((p) => {
        if (p) load(true);
        return false;
      });
    }, 5 * 60_000);
    return () => clearInterval(t);
  }, [mode, load, opts.liveOn?.length]);
  return { data, error, loading, reload: load, setData };
}
