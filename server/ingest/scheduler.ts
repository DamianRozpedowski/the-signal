import { config } from "../config.ts";
import { get, kvSet, nowIso } from "../db.ts";
import { log } from "../log.ts";
import { ingestSource, sourcesDueForFetch, type IngestOutcome } from "./pipeline.ts";

// Background ingestion: a bounded-concurrency queue fed by a periodic "what is due" scan.
// One slow source never blocks others; requests to the same host are spaced out; failures
// back off exponentially (handled in the pipeline via next_fetch_at).

type Trigger = "schedule" | "manual" | "retry";
interface Job {
  sourceId: number;
  trigger: Trigger;
  enqueuedAt: number;
  attempt: number;
}

const queue: Job[] = [];
const running = new Map<number, { startedAt: number; trigger: Trigger }>();
const hostLastHit = new Map<string, number>();
const listeners: ((sourceId: number, outcome: IngestOutcome) => void | Promise<void>)[] = [];
let timer: NodeJS.Timeout | null = null;
let stats = { completed: 0, failed: 0, lastTickAt: null as string | null };

export function onIngested(fn: (sourceId: number, outcome: IngestOutcome) => void | Promise<void>) {
  listeners.push(fn);
}

export function enqueue(sourceId: number, trigger: Trigger = "manual", front = false) {
  if (running.has(sourceId) || queue.some((j) => j.sourceId === sourceId)) return false;
  const job = { sourceId, trigger, enqueuedAt: Date.now(), attempt: 0 };
  if (front) queue.unshift(job);
  else queue.push(job);
  pump();
  return true;
}

function hostOf(sourceId: number) {
  const s = get<{ feed_url: string }>("SELECT feed_url FROM sources WHERE id = ?", sourceId);
  try {
    return s ? new URL(s.feed_url).host : "";
  } catch {
    return "";
  }
}

function pump() {
  while (running.size < config.ingestConcurrency && queue.length) {
    // Pick the first job whose host has not been hit too recently.
    const idx = queue.findIndex((j) => {
      const last = hostLastHit.get(hostOf(j.sourceId)) ?? 0;
      return Date.now() - last >= config.minHostIntervalMs;
    });
    if (idx < 0) {
      setTimeout(pump, config.minHostIntervalMs);
      return;
    }
    const [job] = queue.splice(idx, 1);
    const host = hostOf(job.sourceId);
    hostLastHit.set(host, Date.now());
    running.set(job.sourceId, { startedAt: Date.now(), trigger: job.trigger });
    ingestSource(job.sourceId, job.trigger, job.attempt)
      .then(async (outcome) => {
        if (outcome.status === "error") stats.failed++;
        else stats.completed++;
        for (const l of listeners) {
          try {
            await l(job.sourceId, outcome);
          } catch (e: any) {
            log("error", "scheduler", "Post-ingest hook failed", { error: e?.message });
          }
        }
      })
      .catch((e) => log("error", "scheduler", "Ingest job crashed", { sourceId: job.sourceId, error: e?.message }))
      .finally(() => {
        running.delete(job.sourceId);
        pump();
      });
  }
}

export function tick() {
  stats.lastTickAt = nowIso();
  kvSet("scheduler_last_tick", stats.lastTickAt);
  for (const { id } of sourcesDueForFetch(100)) enqueue(id, "schedule");
}

export function startScheduler(intervalMs = 30_000) {
  if (timer) return;
  log("info", "scheduler", "Ingestion scheduler started", { concurrency: config.ingestConcurrency });
  tick();
  timer = setInterval(tick, intervalMs);
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

export function queueStatus() {
  return {
    running: [...running.entries()].map(([sourceId, r]) => ({ sourceId, trigger: r.trigger, runningForMs: Date.now() - r.startedAt })),
    queued: queue.map((j) => ({ sourceId: j.sourceId, trigger: j.trigger, waitingMs: Date.now() - j.enqueuedAt })),
    concurrency: config.ingestConcurrency,
    schedulerActive: Boolean(timer),
    ...stats,
  };
}

/** Wait until the queue drains (used by tests and the CLI). */
export async function drain(timeoutMs = 60_000) {
  const start = Date.now();
  while ((queue.length || running.size) && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
}
