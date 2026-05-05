/**
 * bench-100k.mjs — Phase 1 acceptance benchmark
 *
 * Creates a fresh in-memory SQLite DB with the production schema (from the
 * 0006_search_fts migration), inserts 100,000 synthetic rows, runs 5 benchmark
 * query types (100 iterations each), reports latency + FTS index size.
 *
 * PASS criterion: all query p99 < 50ms
 *
 * Run: node spike-search/bench-100k.mjs  (from backend/ directory)
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { performance } from "node:perf_hooks";

// ---------------------------------------------------------------------------
// Bootstrap: resolve better-sqlite3 from backend/node_modules
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backendRoot = path.resolve(__dirname, "..");
const betterSqlite3Path = path.resolve(backendRoot, "node_modules/better-sqlite3");

/** @type {typeof import('better-sqlite3')} */
const Database = require(betterSqlite3Path);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hr(label) {
  console.log(`\n${"─".repeat(72)}`);
  console.log(`  ${label}`);
  console.log("─".repeat(72));
}

function pass(msg) { console.log(`  PASS  ${msg}`); }
function fail(msg) { console.error(`  FAIL  ${msg}`); process.exitCode = 1; }
function info(msg) { console.log(`        ${msg}`); }

/**
 * Run fn for `iterations` times, return { mean, p50, p95, p99 } in ms.
 * @param {() => unknown} fn
 * @param {number} iterations
 */
function bench(fn, iterations = 100) {
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const mean = times.reduce((s, v) => s + v, 0) / times.length;
  const p50 = times[Math.ceil(times.length * 0.50) - 1];
  const p95 = times[Math.ceil(times.length * 0.95) - 1];
  const p99 = times[Math.ceil(times.length * 0.99) - 1];
  return { mean, p50, p95, p99 };
}

function fmtMs(v) { return v.toFixed(3) + " ms"; }

// ---------------------------------------------------------------------------
// Section 1 — Schema setup (production schema verbatim from 0006 migration)
// ---------------------------------------------------------------------------

hr("1. Schema Setup");

const db = new Database(":memory:");
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = OFF"); // in-memory bench; no FK overhead

db.exec(`
  CREATE TABLE chat_history (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    app_session_id TEXT    NOT NULL,
    kind           TEXT    NOT NULL,
    payload_json   TEXT    NOT NULL,
    created_at     INTEGER NOT NULL,
    search_text    TEXT
  );

  CREATE INDEX chat_history_session_id_idx ON chat_history(app_session_id, id);

  CREATE VIRTUAL TABLE chat_history_fts USING fts5(
    app_session_id  UNINDEXED,
    search_text,
    content='chat_history',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
  );

  CREATE TRIGGER chat_history_fts_ai AFTER INSERT ON chat_history BEGIN
    INSERT INTO chat_history_fts(rowid, app_session_id, search_text)
      VALUES (new.id, new.app_session_id, COALESCE(new.search_text, ''));
  END;

  CREATE TRIGGER chat_history_fts_ad AFTER DELETE ON chat_history BEGIN
    INSERT INTO chat_history_fts(chat_history_fts, rowid, app_session_id, search_text)
      VALUES('delete', old.id, old.app_session_id, COALESCE(old.search_text, ''));
  END;

  CREATE TRIGGER chat_history_fts_au AFTER UPDATE ON chat_history BEGIN
    INSERT INTO chat_history_fts(chat_history_fts, rowid, app_session_id, search_text)
      VALUES('delete', old.id, old.app_session_id, COALESCE(old.search_text, ''));
    INSERT INTO chat_history_fts(rowid, app_session_id, search_text)
      VALUES (new.id, new.app_session_id, COALESCE(new.search_text, ''));
  END;
`);

pass("Schema created (production schema from 0006_search_fts migration)");

// ---------------------------------------------------------------------------
// Section 2 — extractSearchableText (ported from spike + Phase 1 improvements)
// ---------------------------------------------------------------------------

const MAX_TEXT_BYTES = 16 * 1024;
const REASONING_MAX_BYTES = 4 * 1024;

function truncate(s, maxBytes) {
  if (s.length <= maxBytes) {
    const enc = new TextEncoder();
    const buf = enc.encode(s);
    if (buf.length <= maxBytes) return s;
    return new TextDecoder().decode(buf.slice(0, maxBytes));
  }
  const enc = new TextEncoder();
  const buf = enc.encode(s);
  if (buf.length <= maxBytes) return s;
  return new TextDecoder().decode(buf.slice(0, maxBytes));
}

/**
 * Phase 1 improvement: depth-1 value walk instead of JSON.stringify.
 * @param {Record<string, unknown>} rest
 */
function flattenToolArgs(rest) {
  const out = [];
  for (const v of Object.values(rest)) {
    if (typeof v === "string") {
      out.push(v);
    } else if (typeof v === "number" || typeof v === "boolean") {
      out.push(String(v));
    } else if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === "string") {
          out.push(item);
        } else if (typeof item === "number" || typeof item === "boolean") {
          out.push(String(item));
        } else if (item !== null && typeof item === "object") {
          for (const iv of Object.values(item)) {
            if (typeof iv === "string") out.push(iv);
            else if (typeof iv === "number" || typeof iv === "boolean") out.push(String(iv));
          }
        }
      }
    }
  }
  return out.join(" ");
}

function extractSearchableText(kind, payload) {
  if (!payload || typeof payload !== "object") return null;
  const p = payload;
  const k = kind.replace(/_/g, ".");

  if (k === "user.message" || k === "assistant.message") {
    const raw =
      typeof p["finalText"] === "string" && p["finalText"].length > 0
        ? p["finalText"]
        : typeof p["text"] === "string" ? p["text"] : null;
    return raw ? truncate(raw, MAX_TEXT_BYTES) : null;
  }
  if (k === "reasoning") {
    const raw = typeof p["text"] === "string" ? p["text"] : null;
    return raw ? truncate(raw, REASONING_MAX_BYTES) : null;
  }
  if (k === "tool.call") {
    const name = typeof p["name"] === "string" ? p["name"] : "";
    const { tool_id: _t, duration_s: _d, name: _n, ...rest } = p;
    const argStr = Object.keys(rest).length > 0 ? flattenToolArgs(rest) : "";
    const raw = [name, argStr].filter(Boolean).join(" ");
    return raw ? truncate(raw, MAX_TEXT_BYTES) : null;
  }
  if (k === "tool.result") {
    if (typeof p["text"] === "string") return truncate(p["text"], MAX_TEXT_BYTES);
    const out = p["output"] ?? p["result"] ?? p["content"];
    if (out !== undefined) return truncate(JSON.stringify(out), MAX_TEXT_BYTES);
    return null;
  }
  if (k === "approval.request") {
    const parts = [p["description"], p["command"]].filter(x => typeof x === "string" && x.length > 0);
    const raw = parts.join(" ");
    return raw ? truncate(raw, MAX_TEXT_BYTES) : null;
  }
  if (k === "clarify.request" || k === "sudo.request" || k === "secret.request") {
    const raw = typeof p["text"] === "string" ? p["text"] : null;
    return raw ? truncate(raw, MAX_TEXT_BYTES) : null;
  }
  if (k === "error") {
    const raw = typeof p["text"] === "string" ? p["text"]
      : typeof p["message"] === "string" ? p["message"] : null;
    return raw ? truncate(raw, MAX_TEXT_BYTES) : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Section 3 — Self-tests (all 12 from spike, ported)
// ---------------------------------------------------------------------------

hr("3. extractSearchableText Self-Tests (12 from spike)");

const stTests = [
  {
    label: "user.message uses finalText",
    kind: "user.message",
    payload: { text: "draft", finalText: "OAuth token refresh" },
    expect: "OAuth token refresh",
  },
  {
    label: "user.message falls back to text when no finalText",
    kind: "user.message",
    payload: { text: "OAuth token refresh" },
    expect: "OAuth token refresh",
  },
  {
    label: "assistant.message extracts text",
    kind: "assistant.message",
    payload: { text: "The MCP server connection requires an OAuth token." },
    expect: "The MCP server connection requires an OAuth token.",
  },
  {
    label: "reasoning truncated to 4KB",
    kind: "reasoning",
    payload: { text: "A".repeat(6000) },
    expectMaxBytes: REASONING_MAX_BYTES,
  },
  {
    label: "tool.call includes name + args (excludes tool_id, duration_s)",
    kind: "tool.call",
    payload: { tool_id: "t1", name: "calendar_create", duration_s: 0.1, title: "Sync obsidian vault" },
    expectContains: ["calendar_create", "Sync obsidian vault"],
    expectNotContains: ["tool_id", "duration_s"],
  },
  {
    label: "tool.call underscore variant normalised",
    kind: "tool_call",
    payload: { tool_id: "t2", name: "browser_navigate", duration_s: 0.5, url: "https://example.com" },
    expectContains: ["browser_navigate"],
  },
  {
    label: "tool.result uses text field",
    kind: "tool.result",
    payload: { text: "Successfully created calendar event" },
    expect: "Successfully created calendar event",
  },
  {
    label: "approval.request merges description + command",
    kind: "approval.request",
    payload: { command: "rm -rf /tmp/foo", description: "file deletion", pattern_key: "rm" },
    expectContains: ["file deletion", "rm -rf /tmp/foo"],
  },
  {
    label: "error uses message field",
    kind: "error",
    payload: { message: "Connection timeout to MCP server" },
    expect: "Connection timeout to MCP server",
  },
  {
    label: "unknown kind returns null",
    kind: "unknown.kind",
    payload: { text: "ignored" },
    expect: null,
  },
  {
    label: "null payload returns null",
    kind: "user.message",
    payload: null,
    expect: null,
  },
  {
    label: "16KB hard cap enforced",
    kind: "assistant.message",
    payload: { text: "word ".repeat(5000) },
    expectMaxBytes: MAX_TEXT_BYTES,
  },
];

let stPassed = 0;
let stFailed = 0;
for (const t of stTests) {
  const result = extractSearchableText(t.kind, t.payload);
  let ok = true;
  let reason = "";

  if (t.expect !== undefined) {
    ok = result === t.expect;
    reason = `expected ${JSON.stringify(t.expect)}, got ${JSON.stringify(result)}`;
  } else if (t.expectMaxBytes !== undefined) {
    const byteLen = new TextEncoder().encode(result ?? "").length;
    ok = byteLen <= t.expectMaxBytes;
    reason = `expected <= ${t.expectMaxBytes} bytes, got ${byteLen}`;
  } else if (t.expectContains !== undefined || t.expectNotContains !== undefined) {
    const contains = (t.expectContains ?? []).every(s => result?.includes(s));
    const notContains = (t.expectNotContains ?? []).every(s => !result?.includes(s));
    ok = contains && notContains;
    reason = `result was ${JSON.stringify(result)}`;
  }

  if (ok) {
    stPassed++;
  } else {
    fail(`extractSearchableText [${t.label}]: ${reason}`);
    stFailed++;
  }
}

if (stFailed === 0) {
  pass(`All 12 self-tests passed (${stPassed}/${stTests.length})`);
} else {
  fail(`${stFailed} self-test(s) failed`);
}

// ---------------------------------------------------------------------------
// Section 4 — 100k synthetic rows
// ---------------------------------------------------------------------------

hr("4. Synthetic data — 100,000 rows across 100 sessions");

// Extended CORPUS: base from spike (50 sentences) duplicated for variety
const BASE_CORPUS = [
  "OAuth token rotation strategy for MCP server authentication",
  "calendar event sync with obsidian vault plugin configuration",
  "TypeScript strict mode compiler errors resolved successfully",
  "SQLite FTS5 BM25 ranking implementation details and tuning",
  "React Native FlashList scroll to index performance optimization",
  "Fastify route handler middleware authentication flow design",
  "drizzle ORM migration runner idempotent boot sequence",
  "WebSocket event replay gap detection algorithm design",
  "hermes session context window token budget management",
  "iOS tool queue drain on reconnect pattern implementation",
  "expo push notification token registration and refresh",
  "JWT expiry clock skew tolerance configuration settings",
  "pnpm workspace monorepo shared type packages setup",
  "better-sqlite3 WAL journal mode pragma performance settings",
  "Zod schema validation for API request body parsing",
  "react-native-gesture-handler swipe down trigger implementation",
  "Cmd+K universal keyboard shortcut quick switcher modal",
  "BM25 relevance score interpretation lower negative means better match",
  "snippet function FTS5 HTML bold markers excerpt generation",
  "backfill indexer idempotent search_text NULL rows handling",
  "Can you help me set up the obsidian vault sync today?",
  "The OAuth token keeps expiring before I can refresh it",
  "Calendar event was not created in the correct timezone",
  "I want to search across all my old chat sessions quickly",
  "The MCP server is returning a 401 unauthorized error",
  "How does the BM25 ranking algorithm work exactly?",
  "Let me review the TypeScript compiler output one more time",
  "The hermes session seems to be losing context mid-run",
  "Please create a new calendar event for tomorrow at 2pm",
  "Obsidian vault notes are not being indexed correctly",
  "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do",
  "Ut enim ad minim veniam quis nostrud exercitation ullamco",
  "Duis aute irure dolor in reprehenderit in voluptate velit esse",
  "Excepteur sint occaecat cupidatat non proident sunt in culpa",
  "Laboris nisi ut aliquip ex ea commodo consequat duis aute",
  "browser_navigate returned 200 OK page loaded successfully done",
  "terminal command executed with exit code 0 and no errors found",
  "search_files matched 12 results across 3 directories in project",
  "todo list updated status changed from pending to in_progress",
  "calendar_create event saved successfully to primary calendar",
  "script execution via dash e dash c flag pattern requires approval",
  "Connection timeout after 30 seconds retrying the OAuth request",
  "TypeError cannot read property of undefined at runtime line 47",
  "ENOENT no such file or directory when opening config json file",
  "Rate limit exceeded please retry after 60 seconds OAuth refresh",
  "set up the new project repository folder structure today",
  "the quick brown fox jumps over the lazy dog test sentence",
  "please review and approve the pull request changes carefully",
  "here is a summary of the meeting notes from yesterday session",
  "done the assigned task has been completed successfully thank you",
];

// Duplicate corpus 4x with slight variations to get ~200 unique phrases
const CORPUS = [];
for (let rep = 0; rep < 4; rep++) {
  for (const s of BASE_CORPUS) {
    CORPUS.push(rep === 0 ? s : `[${rep}] ${s}`);
  }
}

const KINDS = [
  "user.message",
  "user.message",
  "assistant.message",
  "assistant.message",
  "tool.call",
  "reasoning",
  "approval.request",
];

const TOOL_NAMES = [
  "calendar_create", "calendar_list", "browser_navigate",
  "search_files", "terminal", "todo", "obsidian_read",
  "mcp_connect", "send_email", "read_file",
];

function makePayload(kind, text) {
  if (kind === "user.message") return JSON.stringify({ text, finalText: text });
  if (kind === "assistant.message" || kind === "reasoning") return JSON.stringify({ text });
  if (kind === "tool.call") {
    const name = TOOL_NAMES[Math.floor(Math.random() * TOOL_NAMES.length)];
    return JSON.stringify({
      tool_id: `call_${Math.random().toString(36).slice(2, 14)}`,
      name,
      duration_s: Math.random() * 2,
      query: text,
      todos: [{ content: text.slice(0, 40), priority: "high" }],
    });
  }
  if (kind === "approval.request") {
    return JSON.stringify({ command: text, description: "requires approval", pattern_key: "generic" });
  }
  return JSON.stringify({ text });
}

const NUM_ROWS = 100_000;
const NUM_SESSIONS = 100;
const SESSION_IDS = Array.from({ length: NUM_SESSIONS }, (_, i) => `session-${String(i + 1).padStart(3, "0")}`);
const baseTs = Math.floor(Date.now() / 1000) - NUM_ROWS * 60;

const insertStmt = db.prepare(
  "INSERT INTO chat_history (app_session_id, kind, payload_json, created_at, search_text) VALUES (?, ?, ?, ?, ?)"
);

const insertMany = db.transaction((rows) => {
  for (const row of rows) {
    insertStmt.run(row.session, row.kind, row.payloadJson, row.createdAt, row.searchText);
  }
});

const t0Insert = performance.now();
const BATCH = 10_000;
for (let start = 0; start < NUM_ROWS; start += BATCH) {
  const batchRows = [];
  for (let i = start; i < Math.min(start + BATCH, NUM_ROWS); i++) {
    const session = SESSION_IDS[i % SESSION_IDS.length];
    const kind = KINDS[i % KINDS.length];
    const text = CORPUS[i % CORPUS.length];
    const payloadJson = makePayload(kind, text);
    let searchText = null;
    try {
      searchText = extractSearchableText(kind, JSON.parse(payloadJson));
    } catch { /* skip */ }
    batchRows.push({ session, kind, payloadJson, createdAt: baseTs + i * 60, searchText });
  }
  insertMany(batchRows);
}
const insertMs = performance.now() - t0Insert;

const chCount = db.prepare("SELECT count(*) AS n FROM chat_history").get().n;
const ftsCount = db.prepare("SELECT count(*) AS n FROM chat_history_fts_docsize").get().n;

pass(`Inserted ${chCount} rows in ${insertMs.toFixed(0)} ms`);

if (ftsCount === chCount) {
  pass(`FTS row count matches: ${ftsCount} rows (verified via chat_history_fts_docsize)`);
} else {
  fail(`FTS count mismatch: chat_history=${chCount}, fts_docsize=${ftsCount}`);
}

// ---------------------------------------------------------------------------
// Section 5 — FTS index size
// ---------------------------------------------------------------------------

hr("5. FTS Index Size");

const pageSizeResult = db.prepare("PRAGMA page_size").get();
const pageCountResult = db.prepare("PRAGMA page_count").get();
const pageSize = pageSizeResult["page_size"] ?? pageSizeResult[Object.keys(pageSizeResult)[0]];
const pageCount = pageCountResult["page_count"] ?? pageCountResult[Object.keys(pageCountResult)[0]];
const dbSizeBytes = pageSize * pageCount;
const dbSizeMb = (dbSizeBytes / 1024 / 1024).toFixed(2);

info(`DB page_size: ${pageSize} bytes`);
info(`DB page_count: ${pageCount}`);
info(`Total in-memory DB size: ${dbSizeMb} MB (includes base table + FTS index)`);
pass(`FTS index size measured: ${dbSizeMb} MB total for ${NUM_ROWS} rows`);

// ---------------------------------------------------------------------------
// Section 6 — BM25 benchmark queries (100 iterations each)
// ---------------------------------------------------------------------------

hr("6. BM25 Query Benchmarks (100 iterations each, 100k rows)");

// Use ⟨MARK⟩/⟨/MARK⟩ markers as locked in Phase 0 decisions
const searchStmt = db.prepare(`
  SELECT
    rowid,
    snippet(chat_history_fts, 1, '⟨MARK⟩', '⟨/MARK⟩', '…', 12) AS snip,
    bm25(chat_history_fts) AS rank
  FROM chat_history_fts
  WHERE chat_history_fts MATCH ?
  ORDER BY rank
  LIMIT 20
`);

const BENCH_QUERIES = [
  { label: "Single common word     ", query: "calendar" },
  { label: "Two words AND          ", query: "calendar event" },
  { label: "Phrase                 ", query: '"OAuth token"' },
  { label: "Prefix                 ", query: "auth*" },
  { label: "No-match query         ", query: "xyzzyqq" },
];

const benchResults = [];
for (const { label, query } of BENCH_QUERIES) {
  let hitCount = 0;
  const stats = bench(() => {
    const results = searchStmt.all(query);
    hitCount = results.length;
  }, 100);
  benchResults.push({ label, query, hitCount, ...stats });
}

console.log();
console.log("  | Query                      | Hits | Mean      | p50       | p95       | p99       |");
console.log("  |---------------------------|------|-----------|-----------|-----------|-----------|");
for (const r of benchResults) {
  const p99Status = r.p99 < 50 ? "OK " : "!!!";
  console.log(
    `  | ${r.label}| ${String(r.hitCount).padStart(4)} | ${fmtMs(r.mean).padStart(9)} | ${fmtMs(r.p50).padStart(9)} | ${fmtMs(r.p95).padStart(9)} | ${fmtMs(r.p99).padStart(9)} | ${p99Status}`
  );
}

const allUnder50 = benchResults.every(r => r.p99 < 50);
if (allUnder50) {
  pass("All queries p99 < 50ms — Phase 1 acceptance criterion MET");
} else {
  const slow = benchResults.filter(r => r.p99 >= 50);
  fail(`Slow queries (p99 >= 50ms): ${slow.map(r => r.label.trim()).join(", ")}`);
}

// Verify ⟨MARK⟩ snippet markers
const sampleResult = searchStmt.all("calendar")[0];
if (sampleResult && sampleResult.snip && sampleResult.snip.includes("⟨MARK⟩")) {
  pass(`snippet() produces ⟨MARK⟩ markers: "${sampleResult.snip.slice(0, 80)}..."`);
} else {
  fail(`snippet() did not produce ⟨MARK⟩ markers: ${JSON.stringify(sampleResult?.snip)}`);
}

// Verify FTS row count via docsize (acceptance criterion #7)
const finalDocsize = db.prepare("SELECT count(*) AS n FROM chat_history_fts_docsize").get().n;
if (finalDocsize === NUM_ROWS) {
  pass(`FTS docsize count verified: ${finalDocsize} (matches chat_history row count) — criterion #7 met`);
} else {
  fail(`FTS docsize count mismatch: ${finalDocsize} vs ${NUM_ROWS}`);
}

// ---------------------------------------------------------------------------
// Section 7 — Final summary
// ---------------------------------------------------------------------------

hr("7. Summary");

info(`Rows:         ${NUM_ROWS} synthetic rows across ${NUM_SESSIONS} sessions`);
info(`Insert time:  ${insertMs.toFixed(0)} ms`);
info(`DB size:      ${dbSizeMb} MB (in-memory)`);
info(`FTS docsize:  ${finalDocsize} rows`);

if (process.exitCode) {
  console.log("\n  One or more assertions FAILED — see FAIL lines above.");
} else {
  pass("All assertions passed. Phase 1 acceptance benchmark PASSED.");
}

db.close();
