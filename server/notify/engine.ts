import nodemailer from "nodemailer";
import webpush from "web-push";
import { getPrefs, type Prefs } from "../auth.ts";
import { config, smtpConfigured, vapidConfigured } from "../config.ts";
import { all, get, nowIso, parseJson, run } from "../db.ts";
import { storiesFor, userContext } from "../edition.ts";
import { emit } from "../events.ts";
import { log } from "../log.ts";
import { keywordRegex } from "../process/topics.ts";
import { isValidTimeZone, parseHm, zonedParts } from "../briefing/time.ts";

// Notification engine. Rules decide *whether* something deserves an alert; dedupe keys make
// sure a story only alerts again when it has a new meaningful development; quiet hours and a
// per-hour cap hold back external delivery (the in-app record is kept and marked held).

type Kind = "breaking" | "followed_story" | "source" | "keyword" | "topic" | "upcoming" | "briefing";

interface Candidate {
  kind: Kind;
  dedupeKey: string;
  clusterId?: number | null;
  articleId?: number | null;
  title: string;
  body: string;
  url: string;
  priority: 1 | 2 | 3;
}

let mailer: ReturnType<typeof nodemailer.createTransport> | null = null;
function getMailer() {
  if (!smtpConfigured()) return null;
  if (!mailer) {
    mailer = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }
  return mailer;
}
if (vapidConfigured()) webpush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey);

export function channelStatus() {
  return {
    in_app: { available: true, detail: "Always available inside the app." },
    browser: { available: true, detail: "Shown by your browser while The Signal is open in a tab, after you grant permission." },
    email: smtpConfigured()
      ? { available: true, detail: `Sent from ${config.smtp.from}.` }
      : { available: false, detail: "Email delivery requires SMTP settings on the server (SMTP_HOST, SMTP_FROM, and credentials)." },
    push: vapidConfigured()
      ? { available: true, detail: "Web Push to subscribed browsers and devices.", publicKey: config.vapid.publicKey }
      : { available: false, detail: "Push delivery requires VAPID keys on the server (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT)." },
  };
}

function inQuietHours(prefs: Prefs, tz: string, now = new Date()) {
  const q = prefs.notifications.quietHours;
  if (!q.enabled) return false;
  const p = zonedParts(now, isValidTimeZone(tz) ? tz : "UTC");
  const mins = p.h * 60 + p.mi;
  const [sh, sm] = parseHm(q.start);
  const [eh, em] = parseHm(q.end);
  const s = sh * 60 + sm;
  const e = eh * 60 + em;
  return s <= e ? mins >= s && mins < e : mins >= s || mins < e;
}

async function deliver(userId: number, c: Candidate) {
  const user = get<{ email: string; timezone: string }>("SELECT email, timezone FROM users WHERE id = ?", userId);
  if (!user) return;
  const prefs = getPrefs(userId);
  const n = prefs.notifications;
  if (!n.enabled || !n.types[c.kind] || c.priority < n.minPriority) return;

  const recent = get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND created_at >= ? AND held_reason IS NULL",
    userId, new Date(Date.now() - 3600_000).toISOString(),
  )!.n;
  const held = inQuietHours(prefs, user.timezone) ? "quiet_hours" : recent >= n.maxPerHour && c.priority < 3 ? "rate_limited" : null;

  const ins = run(
    `INSERT INTO notifications (user_id, kind, dedupe_key, cluster_id, article_id, title, body, url, priority, created_at, held_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, dedupe_key) DO NOTHING`,
    userId, c.kind, c.dedupeKey, c.clusterId ?? null, c.articleId ?? null, c.title, c.body, c.url, c.priority, nowIso(), held,
  );
  if (!ins.changes) return; // already notified for this exact development
  const id = Number(ins.lastInsertRowid);
  const record = (channel: string, status: string, error?: string) =>
    run("INSERT INTO notification_deliveries (notification_id, channel, status, error, at) VALUES (?, ?, ?, ?, ?)", id, channel, status, error ?? null, nowIso());

  record("in_app", "delivered");
  emit({ type: "notification", userId, notificationId: id });

  if (held) {
    for (const ch of ["browser", "email", "push"] as const) if (n.channels[ch]) record(ch, "suppressed", held);
    return;
  }
  if (n.channels.browser) record("browser", "sent_to_open_tabs");
  if (n.channels.email) {
    const m = getMailer();
    if (!m) record("email", "not_configured", "SMTP is not configured on the server.");
    else {
      try {
        await m.sendMail({
          from: config.smtp.from,
          to: user.email,
          subject: c.title,
          text: `${c.body}\n\n${config.publicUrl}${c.url}\n\nYou can change alert settings in The Signal under Settings → Notifications.`,
        });
        record("email", "delivered");
      } catch (e: any) {
        record("email", "failed", e?.message ?? "send failed");
        log("warn", "notify", "Email delivery failed", { notificationId: id, error: e?.message });
      }
    }
  }
  if (n.channels.push) {
    if (!vapidConfigured()) record("push", "not_configured", "VAPID keys are not configured on the server.");
    else {
      const subs = all<{ id: number; endpoint: string; keys: string }>("SELECT id, endpoint, keys FROM push_subscriptions WHERE user_id = ?", userId);
      if (!subs.length) record("push", "failed", "No browser or device has subscribed to push for this account.");
      for (const s of subs) {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: parseJson(s.keys, {} as any) }, JSON.stringify({ title: c.title, body: c.body, url: c.url }));
          record("push", "delivered");
        } catch (e: any) {
          if (e?.statusCode === 404 || e?.statusCode === 410) run("DELETE FROM push_subscriptions WHERE id = ?", s.id);
          record("push", "failed", e?.message ?? "push failed");
        }
      }
    }
  }
}

/** Evaluate alert rules after an ingestion batch touched some clusters. */
export async function evaluateAlerts(touchedClusterIds: number[], newArticleIds: number[]) {
  if (!touchedClusterIds.length && !newArticleIds.length) return;
  const users = all<{ id: number }>("SELECT id FROM users");
  const since = new Date(Date.now() - 2 * 3600_000).toISOString();
  for (const { id: userId } of users) {
    const prefs = getPrefs(userId);
    if (!prefs.notifications.enabled) continue;
    const ctx = userContext(userId);
    const visible = storiesFor(ctx, { clusterIds: touchedClusterIds, includeMuted: false });
    const followedStories = new Set(
      all<{ target_id: number }>("SELECT target_id FROM bookmarks WHERE user_id = ? AND target_type = 'story' AND list = 'following'", userId).map((r) => r.target_id),
    );

    for (const s of visible) {
      const link = `/story/${s.id}`;
      const why = s.reasons.filter((r) => r.points > 0).slice(0, 2).map((r) => r.label).join("; ");
      if (s.isBreaking && s.breakingAt && Date.parse(s.breakingAt) >= Date.now() - 30 * 60_000) {
        await deliver(userId, {
          kind: "breaking", dedupeKey: `breaking:${s.id}`, clusterId: s.id, priority: 3, url: link,
          title: `Breaking: ${s.headline}`,
          body: `${why || "Significant new development"}. Reported by ${s.sourceCount} source${s.sourceCount === 1 ? "" : "s"}, first: ${s.lead.sourceName}.`,
        });
      }
      if (followedStories.has(s.id)) {
        const ev = get<{ id: number; text: string }>(
          "SELECT id, text FROM cluster_events WHERE cluster_id = ? AND significant = 1 AND kind != 'first_report' AND observed_at >= ? ORDER BY id DESC LIMIT 1",
          s.id, since,
        );
        if (ev) {
          await deliver(userId, {
            kind: "followed_story", dedupeKey: `story:${s.id}:${ev.id}`, clusterId: s.id, priority: 2, url: link,
            title: `Update: ${s.headline}`, body: `${ev.text}. Why it matters to you: you follow this story.`,
          });
        }
      }
      const firstReportNew = Date.parse(s.firstPublishedAt) >= Date.now() - 6 * 3600_000;
      const followedTopic = s.topics.find((t) => ctx.followed.has(t));
      if (followedTopic && firstReportNew && s.baseImportance >= 35) {
        await deliver(userId, {
          kind: "topic", dedupeKey: `topic:${followedTopic}:${s.id}`, clusterId: s.id, priority: s.baseImportance >= 55 ? 3 : 2, url: link,
          title: `${ctx.followed.get(followedTopic)}: ${s.headline}`,
          body: `${why || "New story"} in a topic you follow.`,
        });
      }
    }

    // Keyword alerts (preferences + saved searches flagged for alerts), one per story.
    const keywords = [
      ...prefs.notifications.keywords,
      ...all<{ query: string }>("SELECT query FROM saved_searches WHERE user_id = ? AND alert = 1", userId).map((r) => parseJson<{ q?: string }>(r.query, {}).q ?? "").filter(Boolean),
    ];
    if (keywords.length && newArticleIds.length) {
      const res = keywords.map((k) => ({ k, re: keywordRegex(k) }));
      const arts = all<any>(
        `SELECT a.id, a.cluster_id, a.headline, a.description, a.source_id, s.name AS source_name FROM articles a JOIN sources s ON s.id = a.source_id
         WHERE a.id IN (${newArticleIds.map(() => "?").join(",")})`,
        ...newArticleIds,
      );
      for (const a of arts) {
        if (!ctx.active.has(a.source_id)) continue;
        const hit = res.find((r) => r.re.test(`${a.headline} ${a.description ?? ""}`));
        if (!hit) continue;
        await deliver(userId, {
          kind: "keyword", dedupeKey: `kw:${hit.k.toLowerCase()}:${a.cluster_id ?? a.id}`, clusterId: a.cluster_id, articleId: a.id, priority: 2,
          url: a.cluster_id ? `/story/${a.cluster_id}` : `/article/${a.id}`,
          title: `“${hit.k}”: ${a.headline}`, body: `Matched your keyword alert. Reported by ${a.source_name}.`,
        });
      }
    }

    // Selected sources: important items only.
    const alertSources = new Set(prefs.notifications.alertSourceIds);
    if (alertSources.size && newArticleIds.length) {
      const arts = all<any>(
        `SELECT a.id, a.cluster_id, a.headline, a.source_id, s.name AS source_name, c.importance FROM articles a JOIN sources s ON s.id = a.source_id
         LEFT JOIN clusters c ON c.id = a.cluster_id WHERE a.id IN (${newArticleIds.map(() => "?").join(",")})`,
        ...newArticleIds,
      );
      for (const a of arts) {
        if (!alertSources.has(a.source_id) || !ctx.active.has(a.source_id) || (a.importance ?? 0) < 40) continue;
        await deliver(userId, {
          kind: "source", dedupeKey: `source:${a.cluster_id ?? `a${a.id}`}`, clusterId: a.cluster_id, articleId: a.id, priority: 2,
          url: a.cluster_id ? `/story/${a.cluster_id}` : `/article/${a.id}`,
          title: `${a.source_name}: ${a.headline}`, body: "Important item from a source you selected for alerts.",
        });
      }
    }
  }
}

export async function notifyBriefing(userId: number, briefingId: number) {
  const b = get<any>("SELECT edition_date, edition, revision FROM briefings WHERE id = ? AND user_id = ?", briefingId, userId);
  if (!b || b.revision !== 1) return;
  await deliver(userId, {
    kind: "briefing", dedupeKey: `briefing:${b.edition_date}:${b.edition}`, priority: 2, url: "/quick-reads",
    title: `Your ${b.edition === "morning" ? "Morning" : "Evening"} Edition briefing is ready`,
    body: "The essential stories, what changed, and what to watch next.",
  });
}

export async function upcomingTick() {
  const soon = all<any>(
    "SELECT * FROM upcoming_events WHERE starts_at IS NOT NULL AND starts_at >= ? AND starts_at <= ?",
    nowIso(), new Date(Date.now() + 24 * 3600_000).toISOString(),
  );
  if (!soon.length) return;
  for (const { id: userId } of all<{ id: number }>("SELECT id FROM users")) {
    const ctx = userContext(userId);
    const visible = new Set(storiesFor(ctx, { sinceHours: 96, limit: 500 }).map((s) => s.id));
    for (const e of soon) {
      if (e.created_by && e.created_by !== userId) continue;
      if (e.cluster_id && !visible.has(e.cluster_id)) continue;
      await deliver(userId, {
        kind: "upcoming", dedupeKey: `upcoming:${e.id}`, clusterId: e.cluster_id, priority: 1,
        url: e.cluster_id ? `/story/${e.cluster_id}` : "/quick-reads#watch",
        title: `Coming up: ${e.title}`, body: `${e.why ?? ""} (${e.certainty}${e.date_text ? `, ${e.date_text}` : ""})`.trim(),
      });
    }
  }
}

export async function sendTestNotification(userId: number) {
  const key = `test:${Date.now()}`;
  const prefs = getPrefs(userId);
  // Tests bypass type filters but respect channels, so users can verify delivery end to end.
  const saved = prefs.notifications;
  const user = get<{ id: number }>("SELECT id FROM users WHERE id = ?", userId);
  if (!user) return null;
  const forced: Prefs = { ...prefs, notifications: { ...saved, enabled: true, minPriority: 1, quietHours: { ...saved.quietHours, enabled: false }, maxPerHour: 1000, types: { ...saved.types, briefing: true } } };
  await deliverWithPrefs(userId, forced, {
    kind: "briefing", dedupeKey: key, priority: 1, url: "/settings#notifications",
    title: "Test notification from The Signal", body: "If you can read this, this delivery channel works.",
  });
  return get<{ id: number }>("SELECT id FROM notifications WHERE user_id = ? AND dedupe_key = ?", userId, key)?.id ?? null;
}

// Variant of deliver() used only by the test path, with explicit preferences.
async function deliverWithPrefs(userId: number, prefs: Prefs, c: Candidate) {
  const user = get<{ email: string }>("SELECT email FROM users WHERE id = ?", userId)!;
  const ins = run(
    `INSERT INTO notifications (user_id, kind, dedupe_key, title, body, url, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    userId, c.kind, c.dedupeKey, c.title, c.body, c.url, c.priority, nowIso(),
  );
  const id = Number(ins.lastInsertRowid);
  const record = (channel: string, status: string, error?: string) =>
    run("INSERT INTO notification_deliveries (notification_id, channel, status, error, at) VALUES (?, ?, ?, ?, ?)", id, channel, status, error ?? null, nowIso());
  record("in_app", "delivered");
  emit({ type: "notification", userId, notificationId: id });
  const ch = prefs.notifications.channels;
  if (ch.browser) record("browser", "sent_to_open_tabs");
  if (ch.email) {
    const m = getMailer();
    if (!m) record("email", "not_configured", "SMTP is not configured on the server.");
    else
      await m
        .sendMail({ from: config.smtp.from, to: user.email, subject: c.title, text: c.body })
        .then(() => record("email", "delivered"))
        .catch((e: any) => record("email", "failed", e?.message));
  }
  if (ch.push) {
    if (!vapidConfigured()) record("push", "not_configured", "VAPID keys are not configured on the server.");
    else {
      const subs = all<{ endpoint: string; keys: string }>("SELECT endpoint, keys FROM push_subscriptions WHERE user_id = ?", userId);
      if (!subs.length) record("push", "failed", "No browser or device has subscribed to push for this account.");
      for (const s of subs) {
        await webpush
          .sendNotification({ endpoint: s.endpoint, keys: parseJson(s.keys, {} as any) }, JSON.stringify({ title: c.title, body: c.body, url: c.url }))
          .then(() => record("push", "delivered"))
          .catch((e: any) => record("push", "failed", e?.message));
      }
    }
  }
}
