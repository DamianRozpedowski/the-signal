import { all, get, nowIso, run } from "../db.ts";
import { emit } from "../events.ts";
import { log } from "../log.ts";
import { pageImage } from "../process/images.ts";
import { decodeEntities, htmlToText } from "../process/text.ts";
import { checkRobots, fetchText } from "./fetcher.ts";

// Full article text: most feeds carry only a short excerpt, so for stories that matter we
// read the article page itself, when the publisher's robots.txt allows it. Pages behind a
// paywall or rendered by script yield little text and are marked unavailable; nothing is
// done to get around either. The text feeds story synthesis; readers still go to the
// publisher to read the article.

const MIN_CHARS = 500;
const MAX_CHARS = 20_000;
const HOST_INTERVAL_MS = 3000;

const NOISE = [
  /^(advertisement|sponsored|related|read more|more:|see also|watch:|listen:|sign up|subscribe|follow us|share this|copyright|©|all rights reserved)/i,
  /(newsletter|cookie|javascript|your browser|log in|sign in|create an account|already a subscriber|subscribe now|terms of (use|service)|privacy policy)/i,
  /^(photo|image|video|credit|caption|getty images|ap photo|reuters\/)/i,
  /(membership|bookmark your favou?rite|official websites use \.gov|secure \.gov websites|support helps make our show)/i,
];

function fromJsonLd(html: string): string | null {
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: any;
    try {
      data = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    const stack = [data];
    while (stack.length) {
      const x = stack.pop();
      if (!x || typeof x !== "object") continue;
      if (Array.isArray(x)) {
        stack.push(...x);
        continue;
      }
      if (typeof x.articleBody === "string" && x.articleBody.length >= MIN_CHARS) return decodeEntities(htmlToText(x.articleBody));
      if (x["@graph"]) stack.push(x["@graph"]);
    }
  }
  return null;
}

function largestBlock(html: string, tag: string): string | null {
  let best: string | null = null;
  for (const m of html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi"))) {
    if (!best || m[1].length > best.length) best = m[1];
  }
  return best;
}

/** Pull the readable body text out of an article page. Returns paragraphs joined by newlines. */
export function extractArticleText(html: string): string {
  const ld = fromJsonLd(html);
  if (ld && ld.length >= MIN_CHARS) return ld.slice(0, MAX_CHARS);
  const cleaned = html.replace(/<(script|style|noscript|svg|nav|aside|footer|header|form|figure|figcaption|button)\b[\s\S]*?<\/\1>/gi, " ");
  const region = largestBlock(cleaned, "article") ?? largestBlock(cleaned, "main") ?? cleaned;
  const paras: string[] = [];
  const seen = new Set<string>();
  for (const m of region.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const t = htmlToText(m[1]).replace(/\s+/g, " ").trim();
    if (t.length < 60 || !/[.!?"”’)]$/.test(t)) continue;
    if (NOISE.some((re) => re.test(t))) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    paras.push(t);
  }
  return paras.join("\n").slice(0, MAX_CHARS);
}

const hostLastHit = new Map<string, number>();
const priority: number[] = [];

/** Ask for a story's articles to be read soon (e.g. someone just opened the story). */
export function prioritizeCluster(clusterId: number) {
  if (!priority.includes(clusterId)) priority.push(clusterId);
  if (priority.length > 50) priority.shift();
  setTimeout(() => void fullTextTick().catch(() => undefined), 0);
}

export async function fetchArticleText(articleId: number) {
  const a = get<{ id: number; canonical_url: string }>("SELECT id, canonical_url FROM articles WHERE id = ?", articleId);
  if (!a) return "missing" as const;
  const set = (status: string, text: string | null, error: string | null) =>
    run("UPDATE articles SET page_status = ?, page_text = ?, page_error = ?, page_fetched_at = ? WHERE id = ?", status, text, error, nowIso(), a.id);
  try {
    if (!(await checkRobots(a.canonical_url))) {
      set("robots", null, "The publisher's robots.txt disallows automated access to article pages.");
      return "robots" as const;
    }
    const host = new URL(a.canonical_url).host;
    const wait = (hostLastHit.get(host) ?? 0) + HOST_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    hostLastHit.set(host, Date.now());
    const res = await fetchText(a.canonical_url, { accept: "text/html,application/xhtml+xml", maxBytes: 4 * 1024 * 1024, timeoutMs: 15_000 });
    const image = pageImage(res.body, res.finalUrl);
    if (image) run("UPDATE articles SET page_image = ? WHERE id = ?", image, a.id);
    const text = extractArticleText(res.body);
    if (text.length < MIN_CHARS) {
      set("unavailable", null, "The page had no readable article text (it may be paywalled or loaded by script).");
      return "unavailable" as const;
    }
    set("ok", text, null);
    return "ok" as const;
  } catch (e: any) {
    const blocked = e?.status === 401 || e?.status === 402 || e?.status === 403;
    set(blocked ? "unavailable" : "failed", null, blocked ? `The publisher refused the request (HTTP ${e.status}).` : (e?.message ?? "Request failed."));
    return "failed" as const;
  }
}

let busy = false;
/** Read article pages for the stories that matter, a few at a time. */
export async function fullTextTick(max = 12) {
  if (busy) return { fetched: 0 };
  busy = true;
  let fetched = 0;
  try {
    const since = new Date(Date.now() - 72 * 3600_000).toISOString();
    const wanted: { id: number; cluster_id: number }[] = [];
    for (const cid of [...priority].reverse()) {
      wanted.push(...all<{ id: number; cluster_id: number }>("SELECT id, cluster_id FROM articles WHERE cluster_id = ? AND page_status IS NULL ORDER BY published_at DESC LIMIT 20", cid));
      if (wanted.length >= max) break;
    }
    if (wanted.length < max) {
      wanted.push(
        ...all<{ id: number; cluster_id: number }>(
          `SELECT a.id, a.cluster_id FROM articles a JOIN clusters c ON c.id = a.cluster_id
           WHERE a.page_status IS NULL AND a.published_at >= ? AND (c.source_count >= 2 OR c.importance >= 40)
           ORDER BY c.importance DESC, a.published_at DESC LIMIT ?`,
          since, max - wanted.length,
        ),
      );
    }
    const batch = wanted.slice(0, max);
    const clusters = new Set<number>();
    // A few at once; same-host requests are spaced out inside fetchArticleText.
    const queue = batch.slice();
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let job = queue.shift(); job; job = queue.shift()) {
          const r = await fetchArticleText(job.id);
          if (r === "ok") {
            fetched++;
            clusters.add(job.cluster_id);
          }
        }
      }),
    );
    for (const cid of clusters) {
      run("UPDATE clusters SET needs_resummary = 1 WHERE id = ?", cid);
      emit({ type: "cluster", clusterId: cid, reason: "full_text" });
    }
    for (const cid of [...priority]) {
      if (!get("SELECT 1 FROM articles WHERE cluster_id = ? AND page_status IS NULL", cid)) priority.splice(priority.indexOf(cid), 1);
    }
  } catch (e: any) {
    log("error", "fulltext", "Full-text tick failed", { error: e?.message });
  } finally {
    busy = false;
  }
  return { fetched };
}
