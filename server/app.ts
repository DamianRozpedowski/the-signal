import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import {
  createSession, csrfGuard, destroySession, getPrefs, hashPassword, loadUser, rateLimit, requireUser, verifyPassword,
} from "./auth.ts";
import { aiStatusDetail } from "./ai/provider.ts";
import { isValidTimeZone } from "./briefing/time.ts";
import { config } from "./config.ts";
import { all, get, json, nowIso, run } from "./db.ts";
import { lastRefresh, sourceHealthFor } from "./edition.ts";
import { bus, type BusEvent } from "./events.ts";
import { queueStatus } from "./ingest/scheduler.ts";
import { log } from "./log.ts";
import { channelStatus } from "./notify/engine.ts";
import { admin } from "./routes/admin.ts";
import { reader } from "./routes/reader.ts";
import { sources } from "./routes/sources.ts";
import { HttpError, asyncH, parseBody } from "./routes/util.ts";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  app.use(express.json({ limit: "256kb" }));

  // Security headers. Images come from publishers' CDNs, so img-src allows https.
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    next();
  });

  app.use("/api", loadUser, csrfGuard);

  // ---- Health & session -----------------------------------------------------------------

  app.get("/api/health", (_req, res) => {
    let dbOk = true;
    try {
      get("SELECT 1");
    } catch {
      dbOk = false;
    }
    const q = queueStatus();
    res.status(dbOk ? 200 : 503).json({ ok: dbOk, db: dbOk, scheduler: q.schedulerActive, lastTickAt: q.lastTickAt, ai: aiStatusDetail().status, refresh: lastRefresh() });
  });

  app.get("/api/session", (req, res) => {
    const users = get<{ n: number }>("SELECT COUNT(*) AS n FROM users")!.n;
    res.json({
      user: req.user ? { ...req.user, isAdmin: Boolean(req.user.is_admin) } : null,
      prefs: req.user ? getPrefs(req.user.id) : null,
      setupRequired: users === 0,
      signupAllowed: users === 0 || process.env.ALLOW_SIGNUP === "1",
    });
  });

  const Register = z.object({
    email: z.string().email().max(200),
    password: z.string().min(10, "must be at least 10 characters").max(200),
    displayName: z.string().min(1).max(80),
    timezone: z.string().max(64).optional(),
  });

  app.post(
    "/api/auth/register",
    rateLimit(5, 15 * 60_000),
    asyncH((req, res) => {
      const b = parseBody(Register, req.body);
      const users = get<{ n: number }>("SELECT COUNT(*) AS n FROM users")!.n;
      if (users > 0 && process.env.ALLOW_SIGNUP !== "1") throw new HttpError(403, "New accounts are not being accepted on this server.");
      if (get("SELECT 1 FROM users WHERE email = ?", b.email)) throw new HttpError(409, "An account with that email already exists.");
      const tz = b.timezone && isValidTimeZone(b.timezone) ? b.timezone : "UTC";
      const r = run(
        "INSERT INTO users (email, display_name, password_hash, is_admin, timezone, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        b.email, b.displayName, hashPassword(b.password), users === 0 ? 1 : 0, tz, nowIso(),
      );
      createSession(res, Number(r.lastInsertRowid), req.get("user-agent"));
      log("info", "auth", "Account created", { userId: Number(r.lastInsertRowid), admin: users === 0, persist: true });
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/auth/login",
    rateLimit(10, 15 * 60_000),
    asyncH((req, res) => {
      const b = parseBody(z.object({ email: z.string().email(), password: z.string().min(1).max(200) }), req.body);
      const u = get<{ id: number; password_hash: string }>("SELECT id, password_hash FROM users WHERE email = ?", b.email);
      if (!u || !verifyPassword(b.password, u.password_hash)) throw new HttpError(401, "Incorrect email or password.");
      createSession(res, u.id, req.get("user-agent"));
      res.json({ ok: true });
    }),
  );

  app.post("/api/auth/logout", (req, res) => {
    destroySession(req, res);
    res.json({ ok: true });
  });

  app.patch(
    "/api/account",
    requireUser,
    asyncH((req, res) => {
      const b = parseBody(z.object({ displayName: z.string().min(1).max(80).optional(), timezone: z.string().max(64).optional(), language: z.string().max(10).optional() }), req.body);
      if (b.timezone && !isValidTimeZone(b.timezone)) throw new HttpError(400, "Unknown time zone");
      const u = req.user!;
      run("UPDATE users SET display_name = ?, timezone = ?, language = ? WHERE id = ?", b.displayName ?? u.display_name, b.timezone ?? u.timezone, b.language ?? u.language, u.id);
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/account/password",
    requireUser,
    rateLimit(5, 15 * 60_000),
    asyncH((req, res) => {
      const b = parseBody(z.object({ current: z.string(), next: z.string().min(10).max(200) }), req.body);
      const u = get<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ?", req.user!.id)!;
      if (!verifyPassword(b.current, u.password_hash)) throw new HttpError(401, "Current password is incorrect.");
      run("UPDATE users SET password_hash = ? WHERE id = ?", hashPassword(b.next), req.user!.id);
      run("DELETE FROM sessions WHERE user_id = ?", req.user!.id);
      createSession(res, req.user!.id, req.get("user-agent"));
      res.json({ ok: true });
    }),
  );

  app.get("/api/account/export", requireUser, (req, res) => {
    const id = req.user!.id;
    const data = {
      exportedAt: nowIso(),
      account: get("SELECT id, email, display_name, timezone, language, created_at FROM users WHERE id = ?", id),
      preferences: getPrefs(id),
      sourceSelections: all("SELECT us.source_id, s.name, us.enabled, us.priority FROM user_sources us JOIN sources s ON s.id = us.source_id WHERE us.user_id = ?", id),
      customSources: all("SELECT id, name, feed_url, category, created_at FROM sources WHERE created_by = ?", id),
      topics: all("SELECT t.name, t.keywords, ut.state FROM user_topics ut JOIN topics t ON t.id = ut.topic_id WHERE ut.user_id = ?", id),
      bookmarks: all("SELECT * FROM bookmarks WHERE user_id = ?", id),
      readingHistory: all("SELECT target_type, target_id, at FROM reading_history WHERE user_id = ?", id),
      savedSearches: all("SELECT name, query, alert, created_at FROM saved_searches WHERE user_id = ?", id),
      notifications: all("SELECT kind, title, body, url, created_at, read_at FROM notifications WHERE user_id = ?", id),
    };
    res.setHeader("Content-Disposition", `attachment; filename="the-signal-export-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json(data);
  });

  app.delete(
    "/api/account",
    requireUser,
    rateLimit(5, 15 * 60_000),
    asyncH((req, res) => {
      const b = parseBody(z.object({ password: z.string() }), req.body);
      const u = get<{ password_hash: string; is_admin: number }>("SELECT password_hash, is_admin FROM users WHERE id = ?", req.user!.id)!;
      if (!verifyPassword(b.password, u.password_hash)) throw new HttpError(401, "Password is incorrect.");
      if (u.is_admin && get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1")!.n === 1 && get<{ n: number }>("SELECT COUNT(*) AS n FROM users")!.n > 1) {
        throw new HttpError(400, "Make another account an administrator before deleting the only administrator account.");
      }
      // Custom sources the user added are removed with the account; ON DELETE CASCADE handles the rest.
      run("DELETE FROM sources WHERE created_by = ? AND is_custom = 1", req.user!.id);
      run("DELETE FROM users WHERE id = ?", req.user!.id);
      destroySession(req, res);
      res.json({ ok: true });
    }),
  );

  // ---- System status shown in the UI ------------------------------------------------------

  app.get("/api/system/status", requireUser, (req, res) => {
    res.json({
      ai: aiStatusDetail(),
      notificationChannels: channelStatus(),
      refresh: lastRefresh(),
      health: sourceHealthFor(req.user!.id),
      scheduler: { active: queueStatus().schedulerActive, lastTickAt: queueStatus().lastTickAt, running: queueStatus().running.length, queued: queueStatus().queued.length },
      serverTime: nowIso(),
    });
  });

  // ---- Live updates (Server-Sent Events) --------------------------------------------------

  app.get("/api/events", requireUser, (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`event: hello\ndata: ${json({ at: nowIso() })}\n\n`);
    const userId = req.user!.id;
    const onEvent = (e: BusEvent) => {
      if (e.type === "notification" && e.userId !== userId) return;
      if (e.type === "notification") {
        const n = get<any>("SELECT id, title, body, url, kind, priority, held_reason FROM notifications WHERE id = ?", e.notificationId);
        res.write(`event: notification\ndata: ${json(n)}\n\n`);
        return;
      }
      res.write(`event: ${e.type}\ndata: ${json(e)}\n\n`);
    };
    bus.on("event", onEvent);
    const ping = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 25_000);
    req.on("close", () => {
      clearInterval(ping);
      bus.off("event", onEvent);
    });
  });

  app.use("/api/sources", sources);
  app.use("/api/admin", admin);
  app.use("/api", reader);

  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

  // ---- Frontend --------------------------------------------------------------------------
  const dist = path.resolve("dist");
  if (fs.existsSync(path.join(dist, "index.html"))) {
    app.use(express.static(dist, { index: false, maxAge: "1h" }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
  }

  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof HttpError ? err.status : err?.type === "entity.parse.failed" ? 400 : 500;
    if (status >= 500) log("error", "http", `Unhandled error on ${req.method} ${req.path}`, { error: err?.message, stack: String(err?.stack ?? "").slice(0, 2000) });
    res.status(status).json({ error: status >= 500 ? "Something went wrong on the server. The error has been logged." : err.message });
  });

  return app;
}
