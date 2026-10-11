import { EVENT, UNRELATED, atom, rdf, rss, startFixtureServer, tmpDbPath } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { all, get, nowIso, openDb, run } from "../server/db.ts";
import { seedTopics } from "../server/process/topics.ts";
import { ingestSource, validateFeedUrl } from "../server/ingest/pipeline.ts";
import { rebuildIndex } from "../server/process/cluster.ts";
import { storiesFor, userContext } from "../server/edition.ts";
import { generateBriefing } from "../server/briefing/generate.ts";
import { hashPassword } from "../server/auth.ts";
import { evaluateAlerts } from "../server/notify/engine.ts";

let fx: Awaited<ReturnType<typeof startFixtureServer>>;
const ids: Record<string, number> = {};
let userId: number;

function addSource(slug: string, path: string, kind = "publisher", category = "world") {
  const r = run(
    `INSERT INTO sources (slug, name, description, site_url, feed_url, category, kind, region, default_enabled, interval_minutes, created_at)
     VALUES (?, ?, '', 'https://example.test', ?, ?, ?, 'global', 1, 30, ?)`,
    slug, `Fixture ${slug}`, `${fx.base}${path}`, category, kind, nowIso(),
  );
  ids[slug] = Number(r.lastInsertRowid);
}

before(async () => {
  fx = await startFixtureServer();
  openDb(tmpDbPath());
  seedTopics();
  rebuildIndex();
  userId = Number(
    run("INSERT INTO users (email, display_name, password_hash, is_admin, timezone, created_at) VALUES ('t@example.test', 'T', ?, 1, 'UTC', ?)", hashPassword("correct horse battery"), nowIso()).lastInsertRowid,
  );
  fx.routes.set("/alpha.xml", { body: rss("Alpha", [EVENT.a, UNRELATED[0]]), etag: '"alpha-1"' });
  fx.routes.set("/beta.atom", { body: atom("Beta", [EVENT.b, UNRELATED[1]]), type: "application/atom+xml" });
  fx.routes.set("/gamma.rdf", { body: rdf("Gamma", [EVENT.c, UNRELATED[2]]), type: "application/rdf+xml" });
  fx.routes.set("/broken.xml", { status: 500, body: "oops" });
  fx.routes.set("/page.html", { body: `<!doctype html><html><head><link rel="alternate" type="application/rss+xml" href="/alpha.xml"></head><body>hi</body></html>`, type: "text/html" });
  addSource("alpha", "/alpha.xml");
  addSource("beta", "/beta.atom");
  addSource("gamma", "/gamma.rdf");
  addSource("broken", "/broken.xml");
});

after(async () => {
  await fx.close();
});

describe("ingestion pipeline", () => {
  it("ingests RSS, Atom and RDF feeds and normalizes articles", async () => {
    for (const s of ["alpha", "beta", "gamma"]) {
      const r = await ingestSource(ids[s], "manual");
      assert.equal(r.status, "ok", `${s}: ${r.error}`);
      assert.equal(r.stats!.new, 2);
    }
    const a = get<any>("SELECT * FROM articles WHERE canonical_url LIKE '%freedonia-water-law'");
    assert.ok(a, "article stored");
    assert.equal(a.published_at_estimated, 0);
    assert.ok(a.image_url?.startsWith("https://img.example.test/"));
    assert.notEqual(a.published_at, a.retrieved_at, "publication and retrieval times are distinct");
  });

  it("does not create duplicates on repeated retrieval and honours ETag", async () => {
    const before = get<{ n: number }>("SELECT COUNT(*) AS n FROM articles")!.n;
    const r1 = await ingestSource(ids.alpha, "manual");
    assert.equal(r1.status, "not_modified");
    const r2 = await ingestSource(ids.beta, "manual");
    assert.equal(r2.status, "ok");
    assert.equal(r2.stats!.new, 0);
    assert.equal(r2.stats!.duplicate, 2);
    assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM articles")!.n, before);
  });

  it("groups related reporting into one story without losing source links", () => {
    const rows = all<any>("SELECT cluster_id FROM articles WHERE headline LIKE '%Freedonia%'");
    assert.equal(rows.length, 3);
    assert.equal(new Set(rows.map((r) => r.cluster_id)).size, 1, "all three in one cluster");
    const c = get<any>("SELECT * FROM clusters WHERE id = ?", rows[0].cluster_id);
    assert.equal(c.source_count, 3);
    assert.equal(c.article_count, 3);
    const unrelated = all<any>("SELECT cluster_id FROM articles WHERE headline NOT LIKE '%Freedonia%'");
    assert.equal(new Set(unrelated.map((r) => r.cluster_id)).size, 3, "unrelated stories stay separate");
    assert.ok(!unrelated.some((u) => u.cluster_id === rows[0].cluster_id));
  });

  it("ranks the corroborated, consequential story above minor ones", () => {
    const stories = storiesFor(userContext(userId), {});
    assert.ok(stories.length >= 4);
    assert.match(stories[0].headline, /Freedonia/);
    assert.ok(stories[0].reasons.some((r) => /independent sources/.test(r.label)));
    assert.ok(stories[0].reasons.some((r) => r.label === "Major policy decision"));
  });

  it("records a failed source visibly with backoff, without breaking the edition", async () => {
    const r = await ingestSource(ids.broken, "manual");
    assert.equal(r.status, "error");
    const s = get<any>("SELECT * FROM sources WHERE id = ?", ids.broken);
    assert.equal(s.status, "degraded");
    assert.match(s.last_error, /HTTP 500/);
    assert.ok(Date.parse(s.next_fetch_at) > Date.now());
    const job = get<any>("SELECT * FROM ingest_jobs WHERE source_id = ? ORDER BY id DESC LIMIT 1", ids.broken);
    assert.equal(job.status, "error");
    assert.ok(storiesFor(userContext(userId), {}).length > 0);
  });

  it("tracks a meaningful update and a correction on an existing story", async () => {
    const updated = { ...EVENT.a, title: "Freedonia water rationing law takes effect; fines announced for violations", description: EVENT.a.description + " Officials announced fines of up to 500 crowns for violations starting next month." };
    fx.routes.set("/alpha.xml", { body: rss("Alpha", [updated, UNRELATED[0]]), etag: '"alpha-2"' });
    const r = await ingestSource(ids.alpha, "manual");
    assert.equal(r.stats!.updated, 1);
    const art = get<any>("SELECT * FROM articles WHERE canonical_url LIKE '%freedonia-water-law'");
    assert.equal(art.headline, updated.title);
    assert.equal(art.original_headline, EVENT.a.title, "original headline preserved");
    assert.ok(all("SELECT * FROM article_revisions WHERE article_id = ?", art.id).length >= 1);
    const ev = all<any>("SELECT * FROM cluster_events WHERE cluster_id = ? AND kind = 'update'", art.cluster_id);
    assert.ok(ev.length >= 1, "update recorded on timeline");

    const correction = { title: "Correction: Freedonia rationing law vote count", link: "https://gamma.example.test/freedonia-correction", description: "Correction: An earlier version of this story misstated the Freedonia parliament vote on the water rationing law backed by Prime Minister Rufus Firefly.", hoursAgo: 0.5 };
    fx.routes.set("/gamma.rdf", { body: rdf("Gamma", [EVENT.c, UNRELATED[2], correction]), type: "application/rdf+xml" });
    await ingestSource(ids.gamma, "manual");
    const corr = get<any>("SELECT * FROM articles WHERE canonical_url LIKE '%freedonia-correction'");
    assert.equal(corr.correction_status, "corrected");
  });

  it("excludes a disabled source's content from the reader's edition", () => {
    run("INSERT INTO user_sources (user_id, source_id, enabled) VALUES (?, ?, 0)", userId, ids.beta);
    const stories = storiesFor(userContext(userId), {});
    assert.ok(!stories.some((s) => /light rail/.test(s.headline)), "beta-only story hidden");
    const freedonia = stories.find((s) => /Freedonia/.test(s.headline))!;
    assert.ok(!freedonia.sources.some((s) => s.id === ids.beta), "beta link removed from shared story");
    run("DELETE FROM user_sources WHERE user_id = ?", userId);
  });
});

describe("source validation", () => {
  it("accepts a valid feed and discovers feeds from web pages", async () => {
    const v = await validateFeedUrl(`${fx.base}/page.html`);
    assert.ok(v.discoveredFeedUrl?.endsWith("/alpha.xml"));
  });
  it("rejects an already registered feed", async () => {
    const v = await validateFeedUrl(`${fx.base}/alpha.xml`);
    assert.equal(v.ok, false);
    assert.ok(v.duplicateOf);
  });
  it("explains unreachable and non-feed URLs", async () => {
    const v = await validateFeedUrl(`${fx.base}/missing.xml`);
    assert.equal(v.ok, false);
    assert.match(v.checks.find((c) => c.key === "reachable")!.detail, /404/);
  });
  it("respects robots.txt disallow rules", async () => {
    fx.routes.set("/private/feed.xml", { body: rss("Private", [EVENT.a]) });
    const v = await validateFeedUrl(`${fx.base}/private/feed.xml`);
    assert.equal(v.ok, false);
    assert.match(v.checks.find((c) => c.key === "reachable")!.detail, /robots/);
  });
});

describe("quick reads", () => {
  it("builds a briefing from collected stories with sources, and says when AI is not configured", async () => {
    const r = await generateBriefing(userId, { force: true });
    const b = get<any>("SELECT * FROM briefings WHERE id = ?", r.briefingId);
    const content = JSON.parse(b.content);
    assert.equal(b.ai_status, "not_configured");
    assert.ok(content.stories.length >= 1);
    for (const s of content.stories) assert.ok(s.sources.length >= 1, "each story has source references");
    assert.ok(content.modes.two.length <= content.modes.five.length && content.modes.five.length <= content.modes.ten.length);
    assert.ok(content.readingMinutes.two <= content.readingMinutes.ten);
    assert.ok(content.coverageNotes.some((n: any) => n.kind === "ai"));
    const freedonia = content.stories.filter((s: any) => /Freedonia/.test(s.headline));
    assert.equal(freedonia.length, 1, "duplicate reporting is one story");
  });

  it("keeps previous revisions when the briefing is regenerated", async () => {
    const before = get<{ n: number }>("SELECT COUNT(*) AS n FROM briefings WHERE user_id = ?", userId)!.n;
    // A manual refresh with nothing new does not create an empty revision.
    const noop = await generateBriefing(userId, { force: true, reason: "manual" });
    assert.equal(noop.regenerated, false);
    assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM briefings WHERE user_id = ?", userId)!.n, before);
    await generateBriefing(userId, { force: true, reason: "material_update" });
    const rows = all<any>("SELECT revision, supersedes_id FROM briefings WHERE user_id = ? ORDER BY id", userId);
    assert.equal(rows.length, before + 1);
    assert.equal(rows.at(-1).revision, rows.at(-2).revision + 1);
  });
});

describe("notifications", () => {
  it("alerts once per development and never for a duplicate", async () => {
    // Follow the Freedonia story.
    const cid = get<any>("SELECT cluster_id FROM articles WHERE headline LIKE '%Freedonia%' LIMIT 1").cluster_id;
    run("INSERT INTO bookmarks (user_id, target_type, target_id, list, saved_at) VALUES (?, 'story', ?, 'following', ?)", userId, cid, nowIso());
    await evaluateAlerts([cid], []);
    const n1 = get<{ n: number }>("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'followed_story'", userId)!.n;
    assert.equal(n1, 1);
    await evaluateAlerts([cid], []);
    const n2 = get<{ n: number }>("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'followed_story'", userId)!.n;
    assert.equal(n2, 1, "same development does not alert twice");
    const d = all<any>("SELECT * FROM notification_deliveries");
    assert.ok(d.some((x) => x.channel === "in_app" && x.status === "delivered"));
  });

  it("reports email as not configured instead of pretending to send", async () => {
    const { savePrefs } = await import("../server/auth.ts");
    const { sendTestNotification } = await import("../server/notify/engine.ts");
    savePrefs(userId, { notifications: { channels: { in_app: true, browser: false, email: true, push: true } } } as any);
    const id = await sendTestNotification(userId);
    const d = all<any>("SELECT channel, status FROM notification_deliveries WHERE notification_id = ?", id!);
    assert.deepEqual(d.find((x) => x.channel === "email")?.status, "not_configured");
    assert.deepEqual(d.find((x) => x.channel === "push")?.status, "not_configured");
  });
});
