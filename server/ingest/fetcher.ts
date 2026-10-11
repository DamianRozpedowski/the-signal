import dns from "node:dns/promises";
import net from "node:net";
import { Agent, EnvHttpProxyAgent, fetch, type Dispatcher } from "undici";
import { config } from "../config.ts";

// Outbound HTTP for feeds. Guards: http(s) only, no private/loopback targets
// (unless ALLOW_PRIVATE_FEEDS=1), bounded redirects, timeouts and response size.

const dispatcher: Dispatcher =
  process.env.HTTPS_PROXY || process.env.HTTP_PROXY ? new EnvHttpProxyAgent() : new Agent({ connect: { timeout: 10_000 } });

export class FetchError extends Error {
  constructor(
    message: string,
    public code: "invalid_url" | "blocked_address" | "timeout" | "network" | "http" | "too_large" | "too_many_redirects" | "robots",
    public status?: number,
    public retryAfterSec?: number,
  ) {
    super(message);
  }
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  const l = ip.toLowerCase();
  return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80") || l.startsWith("::ffff:127.") || l.startsWith("::ffff:10.") || l.startsWith("::ffff:192.168.");
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new FetchError("That is not a valid URL.", "invalid_url");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new FetchError("Only http and https URLs are supported.", "invalid_url");
  if (u.username || u.password) throw new FetchError("URLs with embedded credentials are not accepted.", "invalid_url");
  if (config.allowPrivateFeeds) return u;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new FetchError("Local network addresses are not allowed as sources.", "blocked_address");
  }
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => {
    throw new FetchError(`Could not resolve host ${host}. Check the address, and that this server has DNS and outbound network access.`, "network");
  });
  if (addrs.some((a) => isPrivateIp(a.address))) {
    throw new FetchError("Local network addresses are not allowed as sources.", "blocked_address");
  }
  return u;
}

export interface FetchResult {
  status: number;
  notModified: boolean;
  finalUrl: string;
  contentType: string;
  body: string;
  etag: string | null;
  lastModified: string | null;
  bytes: number;
}

export async function fetchText(
  url: string,
  opts: { etag?: string | null; lastModified?: string | null; accept?: string; maxBytes?: number; timeoutMs?: number } = {},
): Promise<FetchResult> {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    await assertPublicUrl(current);
    const headers: Record<string, string> = {
      "user-agent": config.userAgent,
      accept: opts.accept ?? "application/rss+xml, application/atom+xml, application/rdf+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5",
      "accept-encoding": "gzip, deflate, br",
    };
    if (opts.etag) headers["if-none-match"] = opts.etag;
    if (opts.lastModified) headers["if-modified-since"] = opts.lastModified;

    let res;
    try {
      res = await fetch(current, {
        headers,
        redirect: "manual",
        dispatcher,
        signal: AbortSignal.timeout(opts.timeoutMs ?? config.fetchTimeoutMs),
      });
    } catch (e: any) {
      if (e?.name === "TimeoutError" || e?.name === "AbortError") throw new FetchError("The source did not respond in time.", "timeout");
      throw new FetchError(`Network error: ${describeNetworkError(e)}`, "network");
    }

    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location")!, current).toString();
      await res.body?.cancel();
      continue;
    }
    if (res.status === 304) {
      await res.body?.cancel();
      return { status: 304, notModified: true, finalUrl: current, contentType: "", body: "", etag: opts.etag ?? null, lastModified: opts.lastModified ?? null, bytes: 0 };
    }
    if (!res.ok) {
      const ra = res.headers.get("retry-after");
      const retryAfterSec = ra ? (Number.isFinite(Number(ra)) ? Number(ra) : Math.max(0, (Date.parse(ra) - Date.now()) / 1000)) : undefined;
      await res.body?.cancel();
      const hint =
        res.status === 401 || res.status === 403
          ? " The publisher requires authentication or blocks automated access."
          : res.status === 404 || res.status === 410
            ? " The feed URL no longer exists."
            : res.status === 429
              ? " The publisher is rate-limiting requests."
              : "";
      throw new FetchError(`HTTP ${res.status}.${hint}`, "http", res.status, retryAfterSec);
    }

    const max = opts.maxBytes ?? config.maxFeedBytes;
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > max) {
          await reader.cancel();
          throw new FetchError(`The response is larger than ${Math.round(max / 1024 / 1024)} MB.`, "too_large");
        }
        chunks.push(value);
      }
    }
    const buf = Buffer.concat(chunks);
    const contentType = res.headers.get("content-type") ?? "";
    const charset = /charset=([\w-]+)/i.exec(contentType)?.[1] ?? /<\?xml[^>]*encoding=["']([\w-]+)["']/i.exec(buf.subarray(0, 200).toString("latin1"))?.[1] ?? "utf-8";
    let body: string;
    try {
      body = new TextDecoder(charset.toLowerCase()).decode(buf);
    } catch {
      body = new TextDecoder("utf-8").decode(buf);
    }
    return {
      status: res.status,
      notModified: false,
      finalUrl: current,
      contentType,
      body,
      etag: res.headers.get("etag"),
      lastModified: res.headers.get("last-modified"),
      bytes: total,
    };
  }
  throw new FetchError("Too many redirects.", "too_many_redirects");
}

// ---- robots.txt -----------------------------------------------------------------
// Feeds are published for automated readers, but we still honour an explicit
// Disallow for our user agent or "*" on the feed path. Cached per host for 24h.

const robotsCache = new Map<string, { at: number; rules: { allow: string[]; disallow: string[] } | null }>();

function parseRobots(txt: string, agentToken: string) {
  const groups: { agents: string[]; allow: string[]; disallow: string[] }[] = [];
  let cur: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], allow: [], disallow: [] };
        groups.push(cur);
      }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (!cur) continue;
      if (key === "allow" && val) cur.allow.push(val);
      if (key === "disallow" && val) cur.disallow.push(val);
    }
  }
  const specific = groups.find((g) => g.agents.some((a) => a !== "*" && agentToken.toLowerCase().includes(a)));
  const star = groups.find((g) => g.agents.includes("*"));
  const g = specific ?? star;
  return g ? { allow: g.allow, disallow: g.disallow } : null;
}

function robotsAllows(rules: { allow: string[]; disallow: string[] } | null, path: string) {
  if (!rules) return true;
  const match = (pat: string) => {
    const re = new RegExp("^" + pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
    return re.test(path) ? pat.length : -1;
  };
  const a = Math.max(-1, ...rules.allow.map(match));
  const d = Math.max(-1, ...rules.disallow.map(match));
  return d < 0 || a >= d;
}

export async function checkRobots(url: string): Promise<boolean> {
  const u = new URL(url);
  const key = `${u.protocol}//${u.host}`;
  const cached = robotsCache.get(key);
  let rules = cached && Date.now() - cached.at < 86_400_000 ? cached.rules : undefined;
  if (rules === undefined) {
    try {
      const r = await fetchText(`${key}/robots.txt`, { accept: "text/plain", maxBytes: 512 * 1024, timeoutMs: 8000 });
      rules = parseRobots(r.body, "TheSignal");
    } catch {
      rules = null; // missing or unreachable robots.txt: no restrictions
    }
    robotsCache.set(key, { at: Date.now(), rules });
  }
  return robotsAllows(rules, u.pathname + u.search);
}

export const _test = { parseRobots, robotsAllows, isPrivateIp };

/** Walk an undici error's cause chain to the most specific, readable reason. */
function describeNetworkError(e: any): string {
  const parts: string[] = [];
  for (let c = e, depth = 0; c && depth < 5; c = c.cause, depth++) {
    const code = typeof c.code === "string" ? c.code : null;
    const msg = typeof c.message === "string" && c.message !== "fetch failed" ? c.message : null;
    if (msg && /Proxy response \((\d+)\)/.test(msg)) return `outbound proxy refused the connection (HTTP ${msg.match(/\((\d+)\)/)![1]}); the host may not be on the network allow-list`;
    if (code && !parts.includes(code)) parts.push(code);
    else if (msg && !parts.includes(msg)) parts.push(msg);
  }
  return parts.at(-1) ?? "unknown";
}
