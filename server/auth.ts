import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.ts";
import { all, get, json, nowIso, parseJson, run } from "./db.ts";

// Accounts and sessions. Passwords use scrypt with a per-user salt; session tokens are
// random 256-bit values stored only as SHA-256 hashes. Cookies are HttpOnly + SameSite=Lax,
// and every state-changing request must carry the X-DW-CSRF header (which cross-site
// forms cannot set) and, when present, a same-origin Origin header.

const COOKIE = "dw_session";
const SESSION_DAYS = 30;

export interface User {
  id: number;
  email: string;
  display_name: string;
  is_admin: number;
  timezone: string;
  language: string;
  created_at: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, saltB64, keyB64] = stored.split("$");
  if (alg !== "scrypt" || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64");
  const key = crypto.scryptSync(pw, Buffer.from(saltB64, "base64"), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(key, expected);
}

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export function createSession(res: Response, userId: number, userAgent?: string) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  run(
    "INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)",
    sha(token), userId, nowIso(), expires.toISOString(), (userAgent ?? "").slice(0, 200),
  );
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.isProduction && config.publicUrl.startsWith("https"),
    expires,
    path: "/",
  });
}

export function destroySession(req: Request, res: Response) {
  const token = readCookie(req, COOKIE);
  if (token) run("DELETE FROM sessions WHERE id = ?", sha(token));
  res.clearCookie(COOKIE, { path: "/" });
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function loadUser(req: Request, _res: Response, next: NextFunction) {
  const token = readCookie(req, COOKIE);
  if (token) {
    const row = get<User & { expires_at: string }>(
      `SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
      sha(token),
    );
    if (row && Date.parse(row.expires_at) > Date.now()) {
      const { expires_at: _e, ...user } = row as any;
      delete (user as any).password_hash;
      req.user = user;
    }
  }
  next();
}

export function requireUser(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: "Sign in required." });
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: "Sign in required." });
  if (!req.user.is_admin) return res.status(403).json({ error: "Administrator access required." });
  next();
}

export function csrfGuard(req: Request, res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.get("x-dw-csrf") !== "1") return res.status(403).json({ error: "Missing request header." });
  const origin = req.get("origin");
  if (origin) {
    const host = req.get("host");
    try {
      if (new URL(origin).host !== host) return res.status(403).json({ error: "Cross-origin request rejected." });
    } catch {
      return res.status(403).json({ error: "Invalid origin." });
    }
  }
  next();
}

// Simple fixed-window rate limiter for sensitive endpoints (per IP + route).
const buckets = new Map<string, { count: number; resetAt: number }>();
export function rateLimit(max: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${req.ip}|${req.baseUrl}${req.path}`;
    const now = Date.now();
    const b = buckets.get(key);
    if (!b || b.resetAt < now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (++b.count > max) {
      res.setHeader("retry-after", Math.ceil((b.resetAt - now) / 1000));
      return res.status(429).json({ error: "Too many attempts. Please wait and try again." });
    }
    next();
  };
}

export function cleanupSessions() {
  run("DELETE FROM sessions WHERE expires_at < ?", nowIso());
}

// ---- Preferences ------------------------------------------------------------------------

export const NAV_SECTIONS = [
  "today", "quick-reads", "live", "world", "us", "politics", "business", "technology", "science", "local",
  "topics", "saved", "archive", "sources", "settings",
] as const;

export interface Prefs {
  theme: "system" | "light" | "dark";
  density: "compact" | "expanded";
  textSize: "sm" | "md" | "lg" | "xl";
  nav: { order: string[]; hidden: string[] };
  homepage: {
    sections: { key: string; enabled: boolean; count: number }[];
    leadCount: number;
    topCount: number;
    showSidebar: boolean;
    showImages: boolean;
  };
  location: { label: string; code: string } | null;
  personalization: number; // 0 = broad editorial, 100 = highly personalized
  briefing: { defaultLength: 2 | 5 | 10; morningCutoff: string; eveningCutoff: string; overnightFrom: string };
  liveUpdates: "realtime" | "every5" | "manual";
  notifications: {
    enabled: boolean;
    types: Record<"breaking" | "followed_story" | "source" | "keyword" | "topic" | "upcoming" | "briefing", boolean>;
    channels: Record<"in_app" | "browser" | "email" | "push", boolean>;
    quietHours: { enabled: boolean; start: string; end: string };
    maxPerHour: number;
    minPriority: 1 | 2 | 3;
    alertSourceIds: number[];
    keywords: string[];
  };
  language: string;
}

export const DEFAULT_PREFS: Prefs = {
  theme: "system",
  density: "expanded",
  textSize: "md",
  nav: { order: [...NAV_SECTIONS], hidden: [] },
  homepage: {
    sections: [
      { key: "world", enabled: true, count: 5 },
      { key: "us", enabled: true, count: 5 },
      { key: "politics", enabled: true, count: 4 },
      { key: "business", enabled: true, count: 5 },
      { key: "technology", enabled: true, count: 5 },
      { key: "science", enabled: true, count: 4 },
      { key: "health", enabled: true, count: 4 },
      { key: "local", enabled: true, count: 4 },
      { key: "climate", enabled: false, count: 4 },
      { key: "energy", enabled: false, count: 3 },
      { key: "education", enabled: false, count: 3 },
      { key: "transportation", enabled: false, count: 3 },
      { key: "sports", enabled: false, count: 4 },
      { key: "culture", enabled: false, count: 3 },
      { key: "entertainment", enabled: false, count: 3 },
    ],
    leadCount: 1,
    topCount: 8,
    showSidebar: true,
    showImages: true,
  },
  location: null,
  personalization: 35,
  briefing: { defaultLength: 5, morningCutoff: "06:00", eveningCutoff: "18:00", overnightFrom: "20:00" },
  liveUpdates: "realtime",
  notifications: {
    enabled: true,
    types: { breaking: true, followed_story: true, source: false, keyword: true, topic: true, upcoming: false, briefing: true },
    channels: { in_app: true, browser: false, email: false, push: false },
    quietHours: { enabled: false, start: "22:00", end: "07:00" },
    maxPerHour: 4,
    minPriority: 2,
    alertSourceIds: [],
    keywords: [],
  },
  language: "en",
};

function deepMerge<T>(base: T, patch: any): T {
  if (Array.isArray(base) || typeof base !== "object" || base === null) return (patch === undefined ? base : patch) as T;
  const out: any = { ...base };
  for (const k of Object.keys(patch ?? {})) {
    if (!(k in (base as any))) continue; // ignore unknown keys
    const bv = (base as any)[k];
    const pv = patch[k];
    out[k] = bv && typeof bv === "object" && !Array.isArray(bv) && pv && typeof pv === "object" && !Array.isArray(pv) ? deepMerge(bv, pv) : pv;
  }
  return out;
}

export function getPrefs(userId: number): Prefs {
  const row = get<{ prefs: string }>("SELECT prefs FROM user_prefs WHERE user_id = ?", userId);
  const stored = parseJson<Partial<Prefs>>(row?.prefs, {});
  const merged = deepMerge(DEFAULT_PREFS, stored);
  // Make sure newly added sections/nav items appear for existing users.
  for (const s of DEFAULT_PREFS.homepage.sections) {
    if (!merged.homepage.sections.some((x) => x.key === s.key)) merged.homepage.sections.push({ ...s, enabled: false });
  }
  for (const n of NAV_SECTIONS) if (!merged.nav.order.includes(n)) merged.nav.order.push(n);
  merged.nav.order = merged.nav.order.filter((n) => (NAV_SECTIONS as readonly string[]).includes(n));
  return merged;
}

export function savePrefs(userId: number, patch: Partial<Prefs>): Prefs {
  const next = deepMerge(getPrefs(userId), patch);
  run(
    "INSERT INTO user_prefs (user_id, prefs, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET prefs = excluded.prefs, updated_at = excluded.updated_at",
    userId, json(next), nowIso(),
  );
  return next;
}

export function resetPrefs(userId: number): Prefs {
  run("DELETE FROM user_prefs WHERE user_id = ?", userId);
  return getPrefs(userId);
}

export function allUserIds(): number[] {
  return all<{ id: number }>("SELECT id FROM users").map((r) => r.id);
}
