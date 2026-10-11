import { XMLParser } from "fast-xml-parser";
import { decodeEntities, htmlToText } from "../process/text.ts";

// Parses RSS 2.0, RSS 1.0 (RDF), Atom 1.0 and JSON Feed into one normalized shape.
// Feed content is untrusted: we only extract text and URLs, never execute or render HTML.

export interface FeedItem {
  guid: string | null;
  url: string;
  title: string;
  descriptionHtml: string;
  description: string;
  contentText: string; // full text if the feed itself includes it (content:encoded / atom content)
  author: string | null;
  publishedAt: Date | null;
  updatedAt: Date | null;
  imageUrl: string | null;
  categories: string[];
}

export interface ParsedFeed {
  format: "rss" | "atom" | "rdf" | "json";
  title: string;
  siteUrl: string | null;
  description: string;
  language: string | null;
  ttlMinutes: number | null;
  items: FeedItem[];
}

export class FeedParseError extends Error {}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  removeNSPrefix: false,
  processEntities: true, // XML-level entities only; HTML entities are decoded after tag stripping
  htmlEntities: false,
  trimValues: true,
  parseTagValue: false,
  cdataPropName: "#cdata",
  isArray: (name) => ["item", "entry", "link", "category", "media:content", "media:thumbnail", "enclosure", "author", "dc:creator"].includes(name),
});

const arr = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

function text(v: any): string {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === "object") {
    if (v["#cdata"] != null) return text(v["#cdata"]);
    if (v["#text"] != null) return String(v["#text"]);
    if (v["xhtml:div"] != null) return JSON.stringify(v["xhtml:div"]);
    if (v["div"] != null) return text(v["div"]);
  }
  return "";
}

const clean = (s: string) => decodeEntities(s).replace(/\s+/g, " ").trim();

export function parseDate(s: string | undefined | null): Date | null {
  if (!s) return null;
  const t = String(s).trim();
  let d = new Date(t);
  if (Number.isNaN(d.getTime())) {
    // Common RFC-822 variants with non-standard zones, e.g. "EDT", "+0000 (UTC)".
    const fixed = t.replace(/\s*\(.*\)$/, "").replace(/\b(EDT|EST|CDT|CST|MDT|MST|PDT|PST)\b/, (z) =>
      ({ EDT: "-0400", EST: "-0500", CDT: "-0500", CST: "-0600", MDT: "-0600", MST: "-0700", PDT: "-0700", PST: "-0800" })[z]!,
    );
    d = new Date(fixed);
  }
  if (Number.isNaN(d.getTime())) return null;
  // Reject absurd dates (before 1995 or more than a day in the future).
  if (d.getTime() < Date.UTC(1995, 0, 1) || d.getTime() > Date.now() + 86_400_000) return null;
  return d;
}

function firstImgSrc(html: string): string | null {
  const m = /<img[^>]+src=["']([^"']+)["']/i.exec(html);
  return m ? decodeEntities(m[1]) : null;
}

function absolutize(u: string | null | undefined, base: string | null): string | null {
  if (!u) return null;
  try {
    const abs = new URL(decodeEntities(u.trim()), base ?? undefined);
    return abs.protocol === "http:" || abs.protocol === "https:" ? abs.toString() : null;
  } catch {
    return null;
  }
}

function mediaImage(it: any, base: string | null): string | null {
  // Feeds often list the same picture at several sizes; take the widest.
  let best: { url: string; width: number } | null = null;
  for (const m of [...arr(it["media:content"]), ...arr(it["media:group"]?.["media:content"])]) {
    const type = m?.["@_type"] ?? "";
    const medium = m?.["@_medium"] ?? "";
    if (m?.["@_url"] && (medium === "image" || type.startsWith("image/") || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(m["@_url"]))) {
      const width = Number(m["@_width"]) || 0;
      if (!best || width > best.width) best = { url: m["@_url"], width };
    }
  }
  if (best) return absolutize(best.url, base);
  for (const t of arr(it["media:thumbnail"])) if (t?.["@_url"]) return absolutize(t["@_url"], base);
  for (const e of arr(it.enclosure)) if (e?.["@_url"] && String(e["@_type"] ?? "").startsWith("image/")) return absolutize(e["@_url"], base);
  if (it["itunes:image"]?.["@_href"]) return absolutize(it["itunes:image"]["@_href"], base);
  return null;
}

function rssItems(items: any[], base: string | null): FeedItem[] {
  return items.map((it) => {
    const linkRaw = arr(it.link).map(text).find(Boolean) ?? "";
    const guidRaw = text(it.guid);
    const isPermalink = typeof it.guid === "object" ? it.guid?.["@_isPermaLink"] !== "false" : true;
    const url = absolutize(linkRaw, base) ?? (isPermalink ? absolutize(guidRaw, base) : null) ?? "";
    const descHtml = text(it.description);
    const contentHtml = text(it["content:encoded"]);
    const author = arr(it["dc:creator"]).map(text).filter(Boolean).join(", ") || arr(it.author).map(text).filter(Boolean).join(", ") || null;
    return {
      guid: guidRaw || null,
      url,
      title: clean(htmlToText(text(it.title))),
      descriptionHtml: descHtml,
      description: htmlToText(descHtml),
      contentText: htmlToText(contentHtml),
      author: author ? clean(author) : null,
      publishedAt: parseDate(text(it.pubDate) || text(it["dc:date"])),
      updatedAt: parseDate(text(it["atom:updated"]) || text(it["dc:modified"])),
      imageUrl: mediaImage(it, base) ?? absolutize(firstImgSrc(descHtml || contentHtml), base),
      categories: arr(it.category).map(text).map(clean).filter(Boolean),
    };
  });
}

function atomLink(links: any[], base: string | null): string | null {
  const alt = links.find((l) => !l?.["@_rel"] || l["@_rel"] === "alternate") ?? links[0];
  return absolutize(typeof alt === "string" ? alt : alt?.["@_href"], base);
}

function atomItems(entries: any[], base: string | null): FeedItem[] {
  return entries.map((e) => {
    const summaryHtml = text(e.summary);
    const contentHtml = text(e.content);
    const authors = arr(e.author).map((a: any) => text(a?.name ?? a)).filter(Boolean);
    return {
      guid: text(e.id) || null,
      url: atomLink(arr(e.link), base) ?? "",
      title: clean(htmlToText(text(e.title))),
      descriptionHtml: summaryHtml || contentHtml,
      description: htmlToText(summaryHtml || contentHtml).slice(0, 2000),
      contentText: summaryHtml ? htmlToText(contentHtml) : "",
      author: authors.length ? clean(authors.join(", ")) : null,
      publishedAt: parseDate(text(e.published) || text(e.issued) || text(e.updated)),
      updatedAt: parseDate(text(e.updated)),
      imageUrl: mediaImage(e, base) ?? absolutize(firstImgSrc(summaryHtml || contentHtml), base),
      categories: arr(e.category).map((c: any) => c?.["@_term"] ?? text(c)).filter(Boolean),
    };
  });
}

export function parseFeed(body: string, feedUrl: string): ParsedFeed {
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{")) return parseJsonFeed(trimmed, feedUrl);
  if (/^<!doctype html|^<html/i.test(trimmed)) {
    throw new FeedParseError("The URL returned a web page, not a feed. Look for an RSS or Atom link on the publisher's site.");
  }
  let doc: any;
  try {
    doc = parser.parse(trimmed);
  } catch (e: any) {
    throw new FeedParseError(`The response is not valid XML (${e?.message ?? "parse error"}).`);
  }
  if (doc.rss?.channel) {
    const ch = Array.isArray(doc.rss.channel) ? doc.rss.channel[0] : doc.rss.channel;
    const site = atomLink(arr(ch.link).filter((l: any) => typeof l === "string" || !l?.["@_rel"]), feedUrl) ?? absolutize(text(ch.link), feedUrl);
    return {
      format: "rss",
      title: clean(text(ch.title)),
      siteUrl: site,
      description: clean(htmlToText(text(ch.description))),
      language: text(ch.language) || null,
      ttlMinutes: Number(text(ch.ttl)) || null,
      items: rssItems(arr(ch.item), site ?? feedUrl),
    };
  }
  if (doc.feed) {
    const f = doc.feed;
    const site = atomLink(arr(f.link).filter((l: any) => l?.["@_rel"] !== "self"), feedUrl);
    return {
      format: "atom",
      title: clean(htmlToText(text(f.title))),
      siteUrl: site,
      description: clean(htmlToText(text(f.subtitle))),
      language: f["@_xml:lang"] ?? null,
      ttlMinutes: null,
      items: atomItems(arr(f.entry), site ?? feedUrl),
    };
  }
  const rdf = doc["rdf:RDF"];
  if (rdf) {
    const ch = rdf.channel ?? {};
    const site = absolutize(text(ch.link), feedUrl);
    return {
      format: "rdf",
      title: clean(text(ch.title)),
      siteUrl: site,
      description: clean(htmlToText(text(ch.description))),
      language: text(ch["dc:language"]) || null,
      ttlMinutes: null,
      items: rssItems(arr(rdf.item), site ?? feedUrl),
    };
  }
  throw new FeedParseError("The response is XML but not an RSS, RDF or Atom feed.");
}

function parseJsonFeed(body: string, feedUrl: string): ParsedFeed {
  let j: any;
  try {
    j = JSON.parse(body);
  } catch {
    throw new FeedParseError("The response is not valid JSON.");
  }
  if (!String(j.version ?? "").includes("jsonfeed.org")) throw new FeedParseError("The JSON response is not a JSON Feed.");
  const site = absolutize(j.home_page_url, feedUrl);
  return {
    format: "json",
    title: clean(String(j.title ?? "")),
    siteUrl: site,
    description: clean(String(j.description ?? "")),
    language: j.language ?? null,
    ttlMinutes: null,
    items: arr(j.items).map((it: any) => ({
      guid: it.id != null ? String(it.id) : null,
      url: absolutize(it.url ?? it.external_url, site ?? feedUrl) ?? "",
      title: clean(String(it.title ?? "")),
      descriptionHtml: String(it.summary ?? it.content_html ?? ""),
      description: htmlToText(String(it.summary ?? it.content_text ?? it.content_html ?? "")).slice(0, 2000),
      contentText: htmlToText(String(it.content_text ?? it.content_html ?? "")),
      author: (arr(it.authors)[0] as any)?.name ?? it.author?.name ?? null,
      publishedAt: parseDate(it.date_published),
      updatedAt: parseDate(it.date_modified),
      imageUrl: absolutize(it.image ?? it.banner_image, site ?? feedUrl),
      categories: arr(it.tags).map(String),
    })),
  };
}
