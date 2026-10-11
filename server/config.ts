import path from "node:path";

// All configuration comes from environment variables, read once at startup.
// Nothing in here is ever sent to the browser except the boolean "configured" flags
// exposed by /api/system/status.

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: int("PORT", 8787),
  dataDir: process.env.DATA_DIR ?? path.resolve("data"),
  get dbPath() {
    return process.env.DATABASE_PATH ?? path.join(this.dataDir, "daily-wire.db");
  },
  isProduction: process.env.NODE_ENV === "production",
  publicUrl: process.env.PUBLIC_URL ?? "http://localhost:8787",

  // Ingestion
  schedulerEnabled: process.env.DISABLE_SCHEDULER !== "1",
  ingestConcurrency: int("INGEST_CONCURRENCY", 4),
  fetchTimeoutMs: int("FETCH_TIMEOUT_MS", 15000),
  maxFeedBytes: int("MAX_FEED_BYTES", 5 * 1024 * 1024),
  minHostIntervalMs: int("MIN_HOST_INTERVAL_MS", 2000),
  userAgent:
    process.env.FEED_USER_AGENT ??
    "TheSignal/0.1 (+personal news reader; respects feed caching headers)",
  // Private/loopback feed URLs are rejected unless explicitly allowed (SSRF guard).
  allowPrivateFeeds: process.env.ALLOW_PRIVATE_FEEDS === "1",

  // AI (Anthropic). Key stays server-side.
  anthropicKeyPresent: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
  aiModel: process.env.AI_MODEL ?? "claude-opus-5-5",
  aiArticleModel: process.env.AI_ARTICLE_MODEL ?? process.env.AI_MODEL ?? "claude-opus-5-5",
  aiDailyArticleBudget: int("AI_DAILY_ARTICLE_SUMMARY_LIMIT", 400),
  aiDisabled: process.env.AI_DISABLED === "1",

  // Notifications
  smtp: {
    host: process.env.SMTP_HOST ?? "",
    port: int("SMTP_PORT", 587),
    user: process.env.SMTP_USER ?? "",
    pass: process.env.SMTP_PASS ?? "",
    from: process.env.SMTP_FROM ?? "",
  },
  vapid: {
    publicKey: process.env.VAPID_PUBLIC_KEY ?? "",
    privateKey: process.env.VAPID_PRIVATE_KEY ?? "",
    subject: process.env.VAPID_SUBJECT ?? "",
  },
};

export const smtpConfigured = () => Boolean(config.smtp.host && config.smtp.from);
export const vapidConfigured = () =>
  Boolean(config.vapid.publicKey && config.vapid.privateKey && config.vapid.subject);
