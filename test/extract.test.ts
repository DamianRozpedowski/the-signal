import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractArticleText } from "../server/ingest/fulltext.ts";
import { extractSynthesis, type ExtractArticle } from "../server/process/extract.ts";

const art = (id: number, source_id: number, source_name: string, headline: string, description: string): ExtractArticle => ({
  id, source_id, source_name, headline, description, content: null, content_basis: "excerpt", article_type: "news",
  published_at: `2026-10-10T0${id}:00:00.000Z`,
});

const ARTS = [
  art(1, 10, "Alpha News", "Storm floods Riverton as river bursts banks", "Heavy rain caused the Riverton river to burst its banks on Friday. At least 12 people were evacuated from homes near the river, officials in Riverton said. Continue reading..."),
  art(2, 20, "Beta Times", "Riverton flooding forces evacuations", "Flooding in Riverton forced at least 12 people from their homes after the river burst its banks. Mayor Jane Holt said shelters had opened at Kingsley School."),
  art(3, 30, "Gamma Wire", "Riverton river floods after heavy rain", "The river in Riverton burst its banks after a night of heavy rain, flooding several streets."),
];

describe("extractive story synthesis", () => {
  it("only quotes sentences that appear in the sources, each cited", () => {
    const ex = extractSynthesis(ARTS)!;
    assert.ok(ex.summary.length >= 2);
    const corpus = ARTS.map((a) => `${a.headline} ${a.description}`).join(" ");
    for (const q of [...ex.summary, ...ex.keyFacts, ...ex.singleSource]) {
      assert.ok(corpus.includes(q.text), `not verbatim: ${q.text}`);
      assert.ok(q.article_ids.length >= 1);
    }
    assert.ok(!JSON.stringify(ex).includes("Continue reading"));
  });

  it("keeps only brief lines that add something, and surfaces figures", () => {
    const ex = extractSynthesis(ARTS)!;
    // Three outlets say the river burst its banks; the brief says it once, then adds new detail.
    assert.equal(ex.summary.filter((q) => /burst (its|the) banks|bursts banks/.test(q.text)).length, 1);
    assert.ok(ex.summary.some((q) => q.text.includes("shelters")));
    const fig = [...ex.summary, ...ex.keyFacts].find((q) => q.text.includes("12"));
    assert.ok(fig, "a sentence with the evacuation figure is surfaced");
    const named = ex.shared.map((e) => e.name.toLowerCase());
    assert.ok(named.includes("riverton"));
    assert.equal(ex.headlines.length, 3);
  });

  it("returns null when there is nothing to quote", () => {
    assert.equal(extractSynthesis([]), null);
  });

  it("uses full article text for the longer story, in reporting order", () => {
    const withText = ARTS.map((a, i) => ({
      ...a,
      page_text: i === 0
        ? "RIVERTON (AP) — Heavy rain caused the Riverton river to burst its banks on Friday.\nEmergency crews used boats to reach residents trapped on Mill Street in Riverton.\n\"We have never seen the river rise this fast,\" said fire chief Ann Ruiz in Riverton.\nForecasters expect the Riverton river to stay above flood stage until Monday."
        : null,
    }));
    const ex = extractSynthesis(withText)!;
    assert.equal(ex.fullTextCount, 1);
    assert.ok(ex.story.length >= 1);
    const corpus = withText.map((a) => `${a.description} ${a.page_text ?? ""}`).join(" ");
    for (const q of [...ex.story, ...ex.quotes]) assert.ok(corpus.includes(q.text), `not verbatim: ${q.text}`);
    assert.ok(!JSON.stringify(ex).includes("(AP)"), "wire datelines are dropped");
    const all = [...ex.summary, ...ex.keyFacts, ...ex.quotes, ...ex.story, ...ex.singleSource];
    assert.equal(all.filter((q) => q.text.includes("never seen the river")).length, 1, "the quotation appears exactly once");
  });

  it("does not repeat the same claim or quotation across sections", () => {
    const same = [
      art(1, 10, "Alpha News", "Mayor resigns over budget", 'Mayor Jane Holt said "it is time for someone else to lead this city" as she resigned on Monday. The council will choose an interim mayor next week.'),
      art(2, 20, "Beta Times", "Holt quits as mayor", 'Jane Holt resigned as mayor on Monday, saying "it is time for someone else to lead this city" after the budget vote failed.'),
      art(3, 30, "Gamma Wire", "Riverton mayor steps down", '"It is time for someone else to lead this city," Holt told reporters at City Hall on Monday.'),
    ];
    const ex = extractSynthesis(same)!;
    const all = [...ex.summary, ...ex.keyFacts, ...ex.quotes, ...ex.story, ...ex.singleSource];
    assert.equal(all.filter((q) => /someone else to lead this city/i.test(q.text)).length, 1);
  });
});

describe("article page text extraction", () => {
  it("prefers JSON-LD articleBody, else article paragraphs without page furniture", () => {
    const body = "The council voted on Tuesday to expand the bus network across the northern districts of the city. ".repeat(8);
    const ld = `<html><script type="application/ld+json">${JSON.stringify({ "@type": "NewsArticle", articleBody: body })}</script><p>Short.</p></html>`;
    assert.equal(extractArticleText(ld), body.trim());
    const html = `<html><nav><p>Home page navigation link text that is long enough to count here.</p></nav><article>
      <p>The council voted on Tuesday to expand the bus network across the northern districts.</p>
      <p>Sign up for our newsletter to get the latest local stories delivered every morning.</p>
      <p>Officials said the first new routes would start running in the spring of next year.</p></article></html>`;
    const t = extractArticleText(html);
    assert.ok(t.includes("expand the bus network") && t.includes("first new routes"));
    assert.ok(!t.includes("newsletter") && !t.includes("navigation"));
  });
});
