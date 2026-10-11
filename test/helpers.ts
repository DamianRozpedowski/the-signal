import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Test-only fixtures. These feeds describe fictional places and organisations and are
// served from a local HTTP server; they are never loaded into a real deployment.

process.env.ALLOW_PRIVATE_FEEDS = "1";
process.env.LOG_SILENT = "1";
process.env.DISABLE_SCHEDULER = "1";
process.env.MIN_HOST_INTERVAL_MS = "0";
delete process.env.ANTHROPIC_API_KEY;

export function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-test-"));
  return path.join(dir, "test.db");
}

const ago = (h: number) => new Date(Date.now() - h * 3600_000).toUTCString();
const agoIso = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

export interface FixtureItem {
  title: string;
  link: string;
  description: string;
  hoursAgo: number;
  guid?: string;
}

export function rss(title: string, items: FixtureItem[]) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>${title}</title><link>https://example.test/</link><description>Fixture feed</description>
${items
  .map(
    (i) => `<item><title><![CDATA[${i.title}]]></title><link>${i.link}</link><guid>${i.guid ?? i.link}</guid>
<description><![CDATA[<p>${i.description}</p>]]></description><pubDate>${ago(i.hoursAgo)}</pubDate><dc:creator>Staff</dc:creator>
<media:content url="https://img.example.test/${encodeURIComponent(i.title.slice(0, 10))}.jpg" medium="image"/></item>`,
  )
  .join("\n")}
</channel></rss>`;
}

export function atom(title: string, items: FixtureItem[]) {
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>${title}</title><link href="https://atom.example.test/"/><id>urn:x</id><updated>${agoIso(0)}</updated>
${items
  .map(
    (i) => `<entry><title>${i.title}</title><link rel="alternate" href="${i.link}"/><id>${i.guid ?? i.link}</id>
<published>${agoIso(i.hoursAgo)}</published><updated>${agoIso(i.hoursAgo)}</updated><summary type="html">&lt;p&gt;${i.description}&lt;/p&gt;</summary><author><name>Reporter</name></author></entry>`,
  )
  .join("\n")}
</feed>`;
}

export function rdf(title: string, items: FixtureItem[]) {
  return `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>${title}</title><link>https://rdf.example.test/</link><description>RDF fixture</description></channel>
${items.map((i) => `<item rdf:about="${i.link}"><title>${i.title}</title><link>${i.link}</link><description>${i.description}</description><dc:date>${agoIso(i.hoursAgo)}</dc:date></item>`).join("\n")}
</rdf:RDF>`;
}

/** Mutable fixture server: tests change `routes` between ingestion runs. */
export function startFixtureServer() {
  const routes = new Map<string, { status?: number; body: string; type?: string; etag?: string }>();
  const hits = new Map<string, number>();
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    hits.set(url, (hits.get(url) ?? 0) + 1);
    if (url === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nDisallow: /private/\n");
      return;
    }
    const r = routes.get(url);
    if (!r) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    if (r.etag && req.headers["if-none-match"] === r.etag) {
      res.writeHead(304);
      res.end();
      return;
    }
    res.writeHead(r.status ?? 200, { "content-type": r.type ?? "application/rss+xml; charset=utf-8", ...(r.etag ? { etag: r.etag } : {}) });
    res.end(r.body);
  });
  return new Promise<{ base: string; routes: typeof routes; hits: typeof hits; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      resolve({ base: `http://127.0.0.1:${port}`, routes, hits, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

// A fictional event covered by three outlets, plus unrelated stories.
export const EVENT = {
  a: {
    title: "Freedonia parliament passes national water rationing law after drought",
    link: "https://alpha.example.test/news/freedonia-water-law",
    description: "Freedonia's parliament passed a law on Tuesday imposing national water rationing as a drought enters its third year, Prime Minister Rufus Firefly said.",
    hoursAgo: 2,
  },
  b: {
    title: "Freedonia approves water rationing law as drought deepens",
    link: "https://beta.example.test/world/freedonia-rationing",
    description: "Lawmakers in Freedonia approved national water rationing on Tuesday, with Prime Minister Rufus Firefly calling the drought an emergency.",
    hoursAgo: 1.8,
  },
  c: {
    title: "What Freedonia's new water rationing law means for farmers",
    link: "https://gamma.example.test/freedonia-water-rationing-farmers",
    description: "Farmers in Freedonia face cuts under the national water rationing law passed by parliament, which Prime Minister Rufus Firefly backed during the drought.",
    hoursAgo: 1.2,
  },
};

export const UNRELATED = [
  {
    title: "Sylvania central bank holds interest rate at 4 percent",
    link: "https://alpha.example.test/business/sylvania-rates",
    description: "The Sylvania central bank kept its benchmark interest rate unchanged at 4 percent, citing cooling inflation.",
    hoursAgo: 3,
  },
  {
    title: "Port Haven opens new light rail line to airport",
    link: "https://beta.example.test/local/port-haven-rail",
    description: "Port Haven's transit agency opened a light rail extension connecting downtown to the airport.",
    hoursAgo: 5,
  },
  {
    title: "Researchers in Marsovia map deep-sea coral reef with robot submarine",
    link: "https://gamma.example.test/science/marsovia-coral",
    description: "Scientists from the Marsovia Ocean Institute used an autonomous submarine to map a coral reef 800 metres deep.",
    hoursAgo: 6,
  },
];
