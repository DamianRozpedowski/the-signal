import { EVENT, UNRELATED, atom, rdf, rss, startFixtureServer, tmpDbPath } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { closeDb, nowIso, openDb, run } from "../server/db.ts";
import { seedAll } from "../server/bootstrap.ts";

// The static edition builder, run end to end as a separate process against fixture feeds.

let fx: Awaited<ReturnType<typeof startFixtureServer>>;
let out: string;
const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(out, "data", `${rel}.json`), "utf8"));

before(async () => {
  fx = await startFixtureServer();
  fx.routes.set("/alpha.xml", { body: rss("Alpha", [EVENT.a, UNRELATED[0]]) });
  fx.routes.set("/beta.atom", { body: atom("Beta", [EVENT.b, UNRELATED[1]]), type: "application/atom+xml" });
  fx.routes.set("/gamma.rdf", { body: rdf("Gamma", [EVENT.c, UNRELATED[2]]), type: "application/rdf+xml" });

  const db = tmpDbPath();
  openDb(db);
  seedAll();
  run("UPDATE sources SET admin_disabled = 1"); // keep the real directory offline in tests
  for (const [slug, p] of [["alpha", "/alpha.xml"], ["beta", "/beta.atom"], ["gamma", "/gamma.rdf"]]) {
    run(
      `INSERT INTO sources (slug, name, description, site_url, feed_url, category, kind, region, default_enabled, interval_minutes, created_at)
       VALUES (?, ?, '', 'https://example.test', ?, 'world', 'publisher', 'global', 1, 30, ?)`,
      slug, `Fixture ${slug}`, `${fx.base}${p}`, nowIso(),
    );
  }
  closeDb();

  out = fs.mkdtempSync(path.join(os.tmpdir(), "dw-static-"));
  fs.writeFileSync(path.join(out, "index.html"), "<!doctype html><title>app</title>");
  await promisify(execFile)(process.execPath, ["--import", "tsx", "server/static/build.ts"], {
    env: { ...process.env, DATABASE_PATH: db, STATIC_OUT: out, STATIC_TIMEZONE: "UTC", STATIC_FULLTEXT_MAX: "0" },
    timeout: 120_000,
  });
});

after(async () => {
  await fx.close();
});

describe("static edition", () => {
  it("publishes the front page, sections and the edition metadata", () => {
    const meta = read("meta");
    assert.ok(meta.version && meta.generatedAt);
    assert.equal(meta.fullText, false);
    const today = read("today");
    const all = [today.lead, ...today.top, ...today.sections.flatMap((s: any) => s.stories)].filter(Boolean);
    assert.ok(all.some((s: any) => /Freedonia/.test(s.headline)), "the clustered event is on the front page");
    const sections = read("categories").categories.map((c: any) => read(`category/${c.key}`));
    assert.ok(sections.some((s: any) => s.stories.some((x: any) => /Freedonia/.test(x.headline))), "sections are published");
  });

  it("publishes each story with its coverage, without whole-article text", () => {
    const today = read("today");
    const card = [today.lead, ...today.top, ...today.sections.flatMap((s: any) => s.stories)].find((s: any) => s && /Freedonia/.test(s.headline));
    const story = read(`story/${card.id}`);
    assert.equal(story.articles.length, 3);
    assert.deepEqual(story.extracted.story, []);
    for (const a of story.articles) assert.equal(read(`article/${a.id}`).content, null);
  });

  it("publishes a search index, sources with a default selection, and SPA fallbacks", () => {
    const idx = read("search-index").articles;
    assert.ok(idx.some((r: any[]) => /water rationing/.test(r[1])));
    const { sources } = read("sources");
    assert.ok(sources.length > 3);
    assert.ok(sources.some((s: any) => s.defaultEnabled === false), "non-default sources are listed so readers can turn them on");
    assert.ok(read("briefing/current").briefing, "a Quick Reads edition is published");
    assert.ok(fs.existsSync(path.join(out, "404.html")));
    assert.ok(fs.existsSync(path.join(out, ".nojekyll")));
  });
});
