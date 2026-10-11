// Image quality: feeds often carry small thumbnails. Where a publisher's image CDN serves the
// same picture at a larger size through a predictable URL, ask for that size instead. These
// rewrites were checked against each CDN; anything unrecognised is returned unchanged.

const RULES: [RegExp, (m: RegExpMatchArray, url: string) => string][] = [
  // BBC: https://ichef.bbci.co.uk/ace/standard/240/... (also /news/240/...)
  [/^(https:\/\/ichef\.bbci\.co\.uk\/(?:ace\/standard|news|ace\/ws))\/\d{2,3}\//, (m, u) => u.replace(m[0], `${m[1]}/976/`)],
  // ABC News: ..._4x3_384.jpg
  [/^https:\/\/s\.abcnews\.com\/.*_(?:4x3|16x9)_(?:144|240|384|608)\.(jpe?g|png)$/i, (m, u) => u.replace(/_(?:4x3|16x9)_\d+\.(jpe?g|png)$/i, `_16x9_992.${m[1]}`)],
  // Dow Jones (WSJ, MarketWatch): https://images.wsj.net/im-12345
  [/^https:\/\/images\.wsj\.net\/im-\d+$/, (_m, u) => `${u}?width=1200`],
];

export function upgradeImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  for (const [re, fix] of RULES) {
    const m = url.match(re);
    if (m) return fix(m, url);
  }
  return url;
}

/** The article's lead image as declared by the page itself (Open Graph / Twitter card). */
export function pageImage(html: string, base: string): string | null {
  const head = html.slice(0, 200_000);
  for (const key of ["og:image:secure_url", "og:image", "twitter:image", "twitter:image:src"]) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key.replace(/:/g, "\\:")}["'][^>]*>`, "i");
    const tag = head.match(re)?.[0];
    const content = tag?.match(/content=["']([^"']+)["']/i)?.[1];
    if (!content) continue;
    try {
      const u = new URL(content.replace(/&amp;/g, "&"), base);
      if (u.protocol === "https:" || u.protocol === "http:") return u.toString();
    } catch {
      /* ignore malformed */
    }
  }
  return null;
}
