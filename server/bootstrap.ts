import { cleanupSessions } from "./auth.ts";
import { aiWorkerTick } from "./ai/tasks.ts";
import { briefingSchedulerTick, generateBriefing } from "./briefing/generate.ts";
import { config } from "./config.ts";
import { all, get, nowIso, run } from "./db.ts";
import { bus, type BusEvent } from "./events.ts";
import { fetchText } from "./ingest/fetcher.ts";
import { fullTextTick } from "./ingest/fulltext.ts";
import { onIngested, startScheduler } from "./ingest/scheduler.ts";
import { log } from "./log.ts";
import { evaluateAlerts, notifyBriefing, upcomingTick } from "./notify/engine.ts";
import { rebuildIndex } from "./process/cluster.ts";
import { rerankRecent } from "./process/rank.ts";
import { seedTopics } from "./process/topics.ts";
import { CATALOG } from "./sources/catalog.ts";

/** Insert built-in sources that are missing. Existing rows (and admin edits) are left alone. */
export function seedSources() {
  let added = 0;
  for (const s of CATALOG) {
    const r = run(
      `INSERT INTO sources (slug, name, description, site_url, feed_url, category, kind, region, default_enabled, interval_minutes, priority, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM sources WHERE slug = ? OR feed_url = ?)`,
      s.slug, s.name, s.description, s.siteUrl, s.feedUrl, s.category, s.kind, s.region, s.defaultEnabled ? 1 : 0, s.intervalMinutes, s.priority ?? 0, nowIso(), s.slug, s.feedUrl,
    );
    added += Number(r.changes);
  }
  return added;
}

/** Check whether saved/archived articles still exist at their original URL (gentle, daily). */
async function linkCheckTick() {
  const rows = all<{ id: number; canonical_url: string }>(
    `SELECT DISTINCT a.id, a.canonical_url FROM bookmarks b JOIN articles a ON a.id = b.target_id
     WHERE b.target_type = 'article' AND (a.link_status = 'unknown' OR a.link_status = 'ok') LIMIT 25`,
  );
  for (const r of rows) {
    try {
      await fetchText(r.canonical_url, { accept: "text/html", maxBytes: 2 * 1024 * 1024, timeoutMs: 10_000 });
      run("UPDATE articles SET link_status = 'ok' WHERE id = ?", r.id);
    } catch (e: any) {
      if (e?.status === 404 || e?.status === 410) run("UPDATE articles SET link_status = 'gone' WHERE id = ?", r.id);
    }
  }
}

export function startBackground() {
  rebuildIndex();

  onIngested(async (_sourceId, outcome) => {
    if (outcome.status !== "ok" || !outcome.stats) return;
    const { touchedClusters, newArticleIds } = outcome.stats;
    await evaluateAlerts(touchedClusters, newArticleIds);
    // Event-driven briefing refresh: only when an important story was touched.
    const important = touchedClusters.length
      ? get<{ n: number }>(`SELECT COUNT(*) AS n FROM clusters WHERE id IN (${touchedClusters.map(() => "?").join(",")}) AND (importance >= 55 OR is_breaking = 1)`, ...touchedClusters)!.n
      : 0;
    if (important) {
      for (const { id } of all<{ id: number }>("SELECT id FROM users")) {
        await generateBriefing(id).catch((e) => log("warn", "briefing", "Event-driven refresh failed", { error: e?.message }));
      }
    }
  });

  bus.on("event", (e: BusEvent) => {
    if (e.type !== "briefing") return;
    const b = get<{ user_id: number }>("SELECT user_id FROM briefings WHERE id = ?", e.briefingId);
    if (b) notifyBriefing(b.user_id, e.briefingId).catch(() => undefined);
  });

  const every = (ms: number, name: string, fn: () => unknown) => {
    const run_ = async () => {
      try {
        await fn();
      } catch (e: any) {
        log("error", "maintenance", `${name} failed`, { error: e?.message });
      }
    };
    setTimeout(run_, 5_000);
    return setInterval(run_, ms);
  };

  if (config.schedulerEnabled) startScheduler();
  if (config.schedulerEnabled) every(20_000, "full-text", () => fullTextTick(20));
  every(60_000, "ai-worker", () => aiWorkerTick());
  every(10 * 60_000, "rerank", () => rerankRecent());
  every(10 * 60_000, "briefings", () => briefingSchedulerTick());
  every(60 * 60_000, "index-rebuild", () => rebuildIndex());
  every(30 * 60_000, "upcoming-alerts", () => upcomingTick());
  every(24 * 60 * 60_000, "link-check", () => linkCheckTick());
  every(24 * 60 * 60_000, "session-cleanup", () => cleanupSessions());
}

export function seedAll() {
  const added = seedSources();
  seedTopics();
  return { sourcesAdded: added };
}
