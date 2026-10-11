import crypto from "node:crypto";

// Text utilities shared by deduplication, classification, clustering and search.
// Everything here is deterministic and dependency-free so it can be unit tested.

export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|cmpid$|ocid$|ito$|smid$|partner$|cid$|ref$|ref_src$|rss$|feed$|src$|sr_share$|at_medium$|at_campaign$|taid$)/i;

/** Canonicalize an article URL so that trivial variants map to the same key. */
export function canonicalizeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return raw.trim();
  }
  u.hash = "";
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "").replace(/^amp\./, "").replace(/^m\./, "");
  u.protocol = "https:";
  const keep = new URLSearchParams();
  for (const [k, v] of [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!TRACKING_PARAMS.test(k)) keep.append(k, v);
  }
  u.search = keep.toString();
  let p = u.pathname.replace(/\/amp\/?$/, "/").replace(/\/index\.html?$/, "/");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  u.pathname = p;
  return u.toString();
}

export function urlKey(raw: string) {
  return sha256(canonicalizeUrl(raw)).slice(0, 32);
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–",
  hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", eacute: "é", copy: "©",
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => safeChar(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => safeChar(Number.parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}
function safeChar(code: number) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** Strip markup from feed HTML into plain text. Feed content is untrusted. */
export function htmlToText(html: string | undefined | null): string {
  if (!html) return "";
  return decodeEntities(
    String(html)
      .replace(/<(script|style|iframe|object|noscript)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export function truncate(s: string, n: number) {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const sp = cut.lastIndexOf(" ");
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, "") + "…";
}

/** Normalized headline used for exact-ish duplicate matching across URL variants. */
export function titleKey(title: string) {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/^(breaking|live|update|updated|watch|video|exclusive|opinion|analysis)\s*[:|-]\s*/g, "")
    .replace(/\s*[|–—-]\s*[^|–—-]{2,40}$/, "") // trailing " - Publisher Name"
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const STOPWORDS = new Set(
  (
    "a about above after again against all also am an and any are aren't as at be because been before being below between both but by " +
    "can can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further had hadn't has hasn't have " +
    "haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's " +
    "its itself let's me more most mustn't my myself no nor not of off on once only or other ought our ours ourselves out over own same shan't " +
    "she she'd she'll she's should shouldn't so some such than that that's the their theirs them themselves then there there's these they " +
    "they'd they'll they're they've this those through to too under until up very was wasn't we we'd we'll we're we've were weren't what " +
    "what's when when's where where's which while who who's whom why why's with won't would wouldn't you you'd you'll you're you've your " +
    "yours yourself yourselves says said say saying new news latest report reports reported reporting according just now year years " +
    "day days week weeks time times one two three first last will may might could would people get gets got make makes made back " +
    "amid over after before told tells via per since still including like us u.s. live updates update watch video photos read more " +
    "monday tuesday wednesday thursday friday saturday sunday today yesterday tomorrow percent mr ms mrs dr"
  ).split(/\s+/),
);

/** Light stemmer: enough to merge plurals and common verb endings for matching. */
export function stem(w: string): string {
  if (w.length <= 4) return w;
  if (w.endsWith("ies") && w.length > 5) return w.slice(0, -3) + "y";
  if (w.endsWith("sses")) return w.slice(0, -2);
  if (w.endsWith("ing") && w.length > 6) return w.slice(0, -3);
  if (w.endsWith("ed") && w.length > 5) return w.slice(0, -2);
  if (w.endsWith("es") && w.length > 5 && /(ch|sh|x|z|ss)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) return w.slice(0, -1);
  return w;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’']s\b/g, "")
    .split(/[^a-z0-9.]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ""))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t) && !/^\d{1,2}$/.test(t));
}

export function terms(text: string): string[] {
  return tokenize(text).map(stem);
}

const ENTITY_STOP = new Set([
  "The", "A", "An", "In", "On", "At", "For", "And", "But", "With", "From", "After", "Before", "As", "By", "Of", "To", "Why", "How",
  "What", "When", "Where", "Who", "This", "That", "These", "Those", "It", "He", "She", "They", "We", "I", "You", "Here", "There",
  "Breaking", "Live", "Update", "Opinion", "Analysis", "Watch", "Video", "Exclusive", "New", "Latest", "Monday", "Tuesday",
  "Wednesday", "Thursday", "Friday", "Saturday", "Sunday", "January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December", "Mr", "Ms", "Mrs", "Dr", "Is", "Are", "Was", "Will", "Can", "Could",
  "If", "Not", "No", "Yes", "All", "More", "Most", "Some", "Its", "His", "Her", "Their", "Our", "Your", "Read", "Photos",
]);

/**
 * Heuristic named-entity extraction: runs of capitalized words (and acronyms) that
 * are not sentence-initial stop words. Good enough for "shared actors/places" signals.
 */
export function extractEntities(text: string): string[] {
  const out = new Map<string, number>();
  const re = /\b([A-Z][a-zA-Z.&'-]+|[A-Z]{2,})(?:\s+(?:of|de|la|del|von|van|al|the)?\s*([A-Z][a-zA-Z.&'-]+|[A-Z]{2,}))*/g;
  for (const m of text.matchAll(re)) {
    let phrase = m[0].trim().replace(/[’']s$/, "").replace(/[.,]+$/, "");
    const words = phrase.split(/\s+/);
    while (words.length && ENTITY_STOP.has(words[0])) words.shift();
    while (words.length && /^(of|de|la|del|von|van|al|the)$/i.test(words[words.length - 1])) words.pop();
    phrase = words.join(" ");
    if (!phrase || phrase.length < 2 || ENTITY_STOP.has(phrase)) continue;
    if (/^[A-Z]$/.test(phrase)) continue;
    const key = phrase.toLowerCase();
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return [...out.keys()].slice(0, 30);
}

/** 64-bit SimHash over word shingles, returned as 16 hex chars. */
export function simhash(text: string): string {
  const toks = tokenize(text);
  const v = new Array<number>(64).fill(0);
  const shingles = toks.length < 3 ? toks : toks.slice(0, -1).map((t, i) => `${t} ${toks[i + 1]}`);
  for (const sh of shingles) {
    const h = crypto.createHash("md5").update(sh).digest();
    for (let i = 0; i < 64; i++) {
      const bit = (h[i >> 3] >> (i & 7)) & 1;
      v[i] += bit ? 1 : -1;
    }
  }
  let hex = "";
  for (let byte = 0; byte < 8; byte++) {
    let b = 0;
    for (let bit = 0; bit < 8; bit++) if (v[byte * 8 + bit] > 0) b |= 1 << bit;
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}

export function hamming(a: string, b: string): number {
  if (a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i += 2) {
    let x = Number.parseInt(a.slice(i, i + 2), 16) ^ Number.parseInt(b.slice(i, i + 2), 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

/** Content fingerprint: exact hash of normalized headline + first part of the body. */
export function fingerprint(title: string, body: string) {
  return sha256(`${titleKey(title)}|${tokenize(body).slice(0, 60).join(" ")}`).slice(0, 32);
}

export function termFreq(list: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of list) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

export function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [, v] of a) na += v * v;
  for (const [, v] of b) nb += v * v;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (w) dot += v * w;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function jaccard<T>(a: Iterable<T>, b: Iterable<T>): number {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export function wordCount(s: string) {
  return s.split(/\s+/).filter(Boolean).length;
}
