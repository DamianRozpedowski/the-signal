import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { config } from "./config.ts";

// Single shared connection. node:sqlite is synchronous, which keeps transactional
// logic simple; heavy work (network, AI) happens outside of transactions.

let _db: DatabaseSync | null = null;
const stmtCache = new Map<string, StatementSync>();

export function db(): DatabaseSync {
  if (!_db) throw new Error("Database not opened");
  return _db;
}

export function openDb(file = config.dbPath): DatabaseSync {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  stmtCache.clear();
  _db = new DatabaseSync(file);
  _db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(_db);
  return _db;
}

export function closeDb() {
  stmtCache.clear();
  _db?.close();
  _db = null;
}

function stmt(sql: string): StatementSync {
  let s = stmtCache.get(sql);
  if (!s) {
    s = db().prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}
export function resetStatementCache() {
  stmtCache.clear();
}

type Param = string | number | bigint | null | Uint8Array;
export function all<T = any>(sql: string, ...params: Param[]): T[] {
  return stmt(sql).all(...params) as T[];
}
export function get<T = any>(sql: string, ...params: Param[]): T | undefined {
  return stmt(sql).get(...params) as T | undefined;
}
export function run(sql: string, ...params: Param[]) {
  return stmt(sql).run(...params);
}
export function tx<T>(fn: () => T): T {
  const d = db();
  d.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    d.exec("COMMIT");
    return r;
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

export const nowIso = () => new Date().toISOString();
export const json = (v: unknown) => JSON.stringify(v ?? null);
export function parseJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== "string" || !v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

const MIGRATIONS: string[] = [
  /* 1: core schema */ `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    language TEXT NOT NULL DEFAULT 'en',
    created_at TEXT NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,               -- sha256 of the cookie token
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    user_agent TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE user_prefs (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    prefs TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE sources (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    site_url TEXT NOT NULL DEFAULT '',
    feed_url TEXT NOT NULL UNIQUE,
    integration TEXT NOT NULL DEFAULT 'rss',   -- rss | atom | rdf | json (detected on fetch)
    category TEXT NOT NULL DEFAULT 'general',
    kind TEXT NOT NULL DEFAULT 'publisher',    -- publisher | wire | official | aggregator | analysis
    region TEXT,                                -- e.g. 'US', 'US-CA', 'GB', 'global'
    language TEXT NOT NULL DEFAULT 'en',
    default_enabled INTEGER NOT NULL DEFAULT 1,
    admin_disabled INTEGER NOT NULL DEFAULT 0,  -- admin kill switch: no ingestion at all
    is_custom INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    interval_minutes INTEGER NOT NULL DEFAULT 30,
    priority INTEGER NOT NULL DEFAULT 0,        -- higher = fetched more eagerly
    etag TEXT,
    last_modified TEXT,
    status TEXT NOT NULL DEFAULT 'pending',     -- pending | ok | degraded | error | disabled
    last_attempt_at TEXT,
    last_success_at TEXT,
    last_new_item_at TEXT,
    last_error TEXT,
    last_http_status INTEGER,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    next_fetch_at TEXT,
    article_count INTEGER NOT NULL DEFAULT 0,
    observed_items_per_day REAL,
    validation TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE user_sources (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, source_id)
  );

  CREATE TABLE clusters (
    id INTEGER PRIMARY KEY,
    headline TEXT NOT NULL,
    summary TEXT,
    summary_at TEXT,
    summary_model TEXT,
    summary_basis_hash TEXT,
    summary_history TEXT NOT NULL DEFAULT '[]',
    key_facts TEXT NOT NULL DEFAULT '[]',
    unresolved TEXT NOT NULL DEFAULT '[]',
    disputed TEXT NOT NULL DEFAULT '[]',
    coverage TEXT,                         -- AI coverage comparison (JSON), null until generated
    summary_error TEXT,
    why_it_matters TEXT,
    category TEXT NOT NULL DEFAULT 'general',
    topics TEXT NOT NULL DEFAULT '[]',
    entities TEXT NOT NULL DEFAULT '[]',
    terms TEXT NOT NULL DEFAULT '[]',
    first_seen_at TEXT NOT NULL,
    first_published_at TEXT,
    last_update_at TEXT NOT NULL,          -- last *meaningful* update
    last_article_at TEXT NOT NULL,         -- last time any article joined
    importance REAL NOT NULL DEFAULT 0,
    importance_reasons TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'active',      -- developing | active | quiet | resolved
    is_breaking INTEGER NOT NULL DEFAULT 0,
    breaking_at TEXT,
    lead_article_id INTEGER,
    article_count INTEGER NOT NULL DEFAULT 0,
    source_count INTEGER NOT NULL DEFAULT 0,
    has_official INTEGER NOT NULL DEFAULT 0,
    needs_resummary INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX clusters_importance ON clusters(importance DESC);
  CREATE INDEX clusters_update ON clusters(last_update_at DESC);

  CREATE TABLE articles (
    id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    guid TEXT,
    canonical_url TEXT NOT NULL,
    url_key TEXT NOT NULL,
    headline TEXT NOT NULL,
    original_headline TEXT NOT NULL,
    title_key TEXT NOT NULL,
    author TEXT,
    description TEXT,
    content TEXT,
    content_basis TEXT NOT NULL DEFAULT 'none',  -- none | excerpt | full_feed_text
    image_url TEXT,
    published_at TEXT NOT NULL,
    published_at_estimated INTEGER NOT NULL DEFAULT 0,
    feed_updated_at TEXT,
    retrieved_at TEXT NOT NULL,
    last_meaningful_update_at TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general',
    category_method TEXT NOT NULL DEFAULT 'rules',
    topics TEXT NOT NULL DEFAULT '[]',
    geo TEXT NOT NULL DEFAULT '[]',
    article_type TEXT NOT NULL DEFAULT 'news',  -- news | opinion | analysis | official | press_release | live
    language TEXT NOT NULL DEFAULT 'en',
    fingerprint TEXT NOT NULL,
    simhash TEXT NOT NULL,
    terms TEXT NOT NULL DEFAULT '[]',
    entities TEXT NOT NULL DEFAULT '[]',
    cluster_id INTEGER REFERENCES clusters(id) ON DELETE SET NULL,
    summary TEXT,
    summary_at TEXT,
    summary_model TEXT,
    summary_basis TEXT,
    review_status TEXT NOT NULL DEFAULT 'unreviewed',
    correction_status TEXT NOT NULL DEFAULT 'none',  -- none | corrected | retracted | updated
    processing_status TEXT NOT NULL DEFAULT 'ingested', -- ingested | classified | clustered | summarized | failed
    processing_error TEXT,
    link_status TEXT NOT NULL DEFAULT 'unknown',  -- unknown | ok | gone
    UNIQUE (source_id, url_key)
  );
  CREATE INDEX articles_url_key ON articles(url_key);
  CREATE INDEX articles_title_key ON articles(title_key);
  CREATE INDEX articles_fp ON articles(fingerprint);
  CREATE INDEX articles_cluster ON articles(cluster_id);
  CREATE INDEX articles_published ON articles(published_at DESC);
  CREATE INDEX articles_retrieved ON articles(retrieved_at DESC);
  CREATE INDEX articles_source ON articles(source_id, published_at DESC);
  CREATE INDEX articles_category ON articles(category, published_at DESC);

  CREATE TABLE article_revisions (
    id INTEGER PRIMARY KEY,
    article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    field TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    significant INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX article_revisions_article ON article_revisions(article_id);

  CREATE TABLE cluster_events (
    id INTEGER PRIMARY KEY,
    cluster_id INTEGER NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
    at TEXT NOT NULL,              -- when it happened (publication time of the evidence)
    observed_at TEXT NOT NULL,     -- when we saw it
    kind TEXT NOT NULL,            -- first_report | new_source | update | official | correction | retraction | merged
    article_id INTEGER REFERENCES articles(id) ON DELETE SET NULL,
    text TEXT NOT NULL,
    significant INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX cluster_events_cluster ON cluster_events(cluster_id, at);

  CREATE TABLE duplicate_log (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    source_id INTEGER,
    candidate_url TEXT NOT NULL,
    candidate_title TEXT,
    matched_article_id INTEGER,
    method TEXT NOT NULL,          -- url | guid | title | fingerprint
    action TEXT NOT NULL           -- skipped | updated
  );

  CREATE VIRTUAL TABLE articles_fts USING fts5(
    headline, description, content, source_name, tokenize = 'porter unicode61'
  );

  CREATE TABLE briefings (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    edition_date TEXT NOT NULL,      -- YYYY-MM-DD in the briefing's timezone
    edition TEXT NOT NULL,           -- morning | evening
    timezone TEXT NOT NULL,
    window_start TEXT NOT NULL,
    window_end TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    data_refreshed_at TEXT,
    status TEXT NOT NULL,            -- live | final
    revision INTEGER NOT NULL DEFAULT 1,
    supersedes_id INTEGER REFERENCES briefings(id),
    revision_reason TEXT,
    ai_status TEXT NOT NULL,         -- generated | not_configured | failed | partial
    ai_model TEXT,
    content TEXT NOT NULL,           -- JSON: bigPicture, stories, modes, changes, overnight, watch, coverage notes
    story_ids TEXT NOT NULL DEFAULT '[]',
    source_refs TEXT NOT NULL DEFAULT '[]',
    signature TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX briefings_user_date ON briefings(user_id, edition_date DESC, edition, revision DESC);

  CREATE TABLE upcoming_events (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    starts_at TEXT,
    date_text TEXT,
    certainty TEXT NOT NULL DEFAULT 'scheduled',   -- confirmed | scheduled | estimated
    why TEXT,
    category TEXT,
    cluster_id INTEGER REFERENCES clusters(id) ON DELETE SET NULL,
    article_id INTEGER REFERENCES articles(id) ON DELETE SET NULL,
    source_name TEXT,
    source_url TEXT,
    origin TEXT NOT NULL,                           -- ai_extracted | user
    created_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    dedupe_key TEXT UNIQUE
  );

  CREATE TABLE bookmarks (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL,        -- article | story | briefing
    target_id INTEGER NOT NULL,
    list TEXT NOT NULL DEFAULT 'saved',   -- saved | later | collection name
    note TEXT,
    saved_at TEXT NOT NULL,
    read_at TEXT,
    PRIMARY KEY (user_id, target_type, target_id, list)
  );
  CREATE TABLE reading_history (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX reading_history_user ON reading_history(user_id, at DESC);
  CREATE TABLE story_visits (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cluster_id INTEGER NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
    last_visit_at TEXT NOT NULL,
    PRIMARY KEY (user_id, cluster_id)
  );

  CREATE TABLE topics (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    keywords TEXT NOT NULL DEFAULT '[]',
    categories TEXT NOT NULL DEFAULT '[]',
    match_mode TEXT NOT NULL DEFAULT 'any',   -- any | all (keywords)
    owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,   -- null = built-in
    created_at TEXT NOT NULL,
    UNIQUE (slug, owner_id)
  );
  CREATE TABLE user_topics (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    state TEXT NOT NULL,           -- follow | mute
    PRIMARY KEY (user_id, topic_id)
  );
  CREATE TABLE saved_searches (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    query TEXT NOT NULL,
    alert INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE notifications (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,              -- breaking | followed_story | source | keyword | topic | upcoming | briefing
    dedupe_key TEXT NOT NULL,
    cluster_id INTEGER,
    article_id INTEGER,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    url TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    read_at TEXT,
    held_reason TEXT,                -- quiet_hours | rate_limited (in-app only)
    UNIQUE (user_id, dedupe_key)
  );
  CREATE INDEX notifications_user ON notifications(user_id, created_at DESC);
  CREATE TABLE notification_deliveries (
    id INTEGER PRIMARY KEY,
    notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
    channel TEXT NOT NULL,           -- in_app | browser | email | push
    status TEXT NOT NULL,            -- delivered | queued | failed | not_configured | suppressed
    error TEXT,
    at TEXT NOT NULL
  );
  CREATE TABLE push_subscriptions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    keys TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE ingest_jobs (
    id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    trigger TEXT NOT NULL,           -- schedule | manual | validation | retry
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,            -- running | ok | not_modified | error
    http_status INTEGER,
    items_found INTEGER NOT NULL DEFAULT 0,
    items_new INTEGER NOT NULL DEFAULT 0,
    items_updated INTEGER NOT NULL DEFAULT 0,
    items_duplicate INTEGER NOT NULL DEFAULT 0,
    items_invalid INTEGER NOT NULL DEFAULT 0,
    retry_count INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER,
    error TEXT
  );
  CREATE INDEX ingest_jobs_source ON ingest_jobs(source_id, started_at DESC);
  CREATE INDEX ingest_jobs_started ON ingest_jobs(started_at DESC);

  CREATE TABLE ai_jobs (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,              -- article_summary | cluster_summary | briefing | events | qa | weekly
    target_id INTEGER,
    status TEXT NOT NULL,            -- ok | error | skipped
    model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    error TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE INDEX ai_jobs_started ON ai_jobs(started_at DESC);

  CREATE TABLE app_log (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    level TEXT NOT NULL,
    area TEXT NOT NULL,
    message TEXT NOT NULL,
    data TEXT
  );
  CREATE INDEX app_log_at ON app_log(at DESC);

  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  // 2: full article text fetched from the publisher's page (where robots.txt allows it).
  `
  ALTER TABLE articles ADD COLUMN page_text TEXT;
  ALTER TABLE articles ADD COLUMN page_status TEXT;  -- NULL (not tried) | ok | robots | unavailable | failed
  ALTER TABLE articles ADD COLUMN page_error TEXT;
  ALTER TABLE articles ADD COLUMN page_fetched_at TEXT;
  CREATE INDEX articles_page_status ON articles(page_status);
  `,
  // 3: the article page's own lead image (usually far larger than the feed thumbnail).
  // Pages already read are queued again once so their image is picked up.
  `
  ALTER TABLE articles ADD COLUMN page_image TEXT;
  UPDATE articles SET page_status = NULL WHERE page_status = 'ok';
  `,
];

function migrate(d: DatabaseSync) {
  d.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = d.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) d.prepare("INSERT INTO schema_version (version) VALUES (0)").run();
  while (version < MIGRATIONS.length) {
    d.exec("BEGIN");
    try {
      d.exec(MIGRATIONS[version]);
      version += 1;
      d.prepare("UPDATE schema_version SET version = ?").run(version);
      d.exec("COMMIT");
    } catch (e) {
      d.exec("ROLLBACK");
      throw e;
    }
  }
}

export function kvGet<T>(key: string, fallback: T): T {
  const r = get<{ value: string }>("SELECT value FROM kv WHERE key = ?", key);
  return r ? parseJson(r.value, fallback) : fallback;
}
export function kvSet(key: string, value: unknown) {
  run(
    "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    key,
    json(value),
    nowIso(),
  );
}
