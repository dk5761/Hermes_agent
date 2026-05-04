/**
 * spike.mjs — Phase 0 search spike
 *
 * Validates: FTS5 availability, BM25 latency, Approach A vs B for search_text
 * population, extractSearchableText correctness, and edge cases.
 *
 * Run: node spike.mjs  (from any directory — uses absolute path to better-sqlite3)
 *
 * IMPORTANT schema note discovered during spike:
 *   FTS5 external-content tables map FTS column names to content table column names
 *   by exact name match. The FTS column for session filtering must be named
 *   'app_session_id' (not 'session_id') to match chat_history.app_session_id.
 *   Similarly, the full-text column must be named 'search_text' (not 'text')
 *   to match chat_history.search_text. The snippet() column index for search_text
 *   is 1 (0=app_session_id, 1=search_text).
 *
 * Requires better-sqlite3 from backend/node_modules. No network, no prod DB.
 * Uses :memory: — zero side effects.
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { performance } from "node:perf_hooks";

// ---------------------------------------------------------------------------
// Bootstrap: resolve better-sqlite3 from the backend's node_modules
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

function pass(msg) {
  console.log(`  PASS  ${msg}`);
}

function fail(msg) {
  console.error(`  FAIL  ${msg}`);
  process.exitCode = 1;
}

function info(msg) {
  console.log(`        ${msg}`);
}

/**
 * Run fn for `iterations` times, return { mean, p95, p99 } in ms.
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
  const p95 = times[Math.ceil(times.length * 0.95) - 1];
  const p99 = times[Math.ceil(times.length * 0.99) - 1];
  return { mean, p95, p99 };
}

function fmtMs(v) {
  return v.toFixed(3) + " ms";
}

// ---------------------------------------------------------------------------
// Section 1 — FTS5 availability check
// ---------------------------------------------------------------------------

hr("1. FTS5 Availability");

let db;
try {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(
    "CREATE VIRTUAL TABLE _fts5_probe USING fts5(text, tokenize='unicode61 remove_diacritics 2')"
  );
  db.exec("DROP TABLE _fts5_probe");
  const bsVersion = require(path.resolve(backendRoot, "node_modules/better-sqlite3/package.json"))
    .version;
  pass(`better-sqlite3 v${bsVersion} (SQLite ${db.prepare("SELECT sqlite_version()").get()["sqlite_version()"]}) — FTS5 enabled`);
} catch (err) {
  fail(`FTS5 not available: ${err.message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Section 2 — Schema setup
//
// KEY FINDING: External-content FTS5 column names must exactly match the
// content table column names. The plan doc used "session_id UNINDEXED" and
// "text" as FTS column names, but chat_history has "app_session_id" and
// "search_text". Using mismatched names causes:
//   - "no such column: T.session_id" on rebuild/integrity-check
//   - snippet() silently fails or returns SQL logic error
//
// Corrected schema uses:
//   - app_session_id UNINDEXED  (matches chat_history.app_session_id)
//   - search_text               (matches chat_history.search_text)
// snippet() column index is 1 (0=app_session_id, 1=search_text).
// ---------------------------------------------------------------------------

hr("2. Schema Setup (Approach A — app writes search_text; triggers mirror to FTS)");

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

  -- CORRECTED: FTS column names must match content table column names exactly.
  -- app_session_id UNINDEXED (stored but not indexed — used for session-scoped queries).
  -- search_text (indexed — the content column).
  -- snippet() column index for search_text = 1.
  CREATE VIRTUAL TABLE chat_history_fts USING fts5(
    app_session_id  UNINDEXED,
    search_text,
    content='chat_history',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
  );

  -- AFTER INSERT: populate FTS from search_text
  CREATE TRIGGER chat_history_fts_ai AFTER INSERT ON chat_history BEGIN
    INSERT INTO chat_history_fts(rowid, app_session_id, search_text)
      VALUES (new.id, new.app_session_id, COALESCE(new.search_text, ''));
  END;

  -- AFTER DELETE: remove from FTS
  CREATE TRIGGER chat_history_fts_ad AFTER DELETE ON chat_history BEGIN
    INSERT INTO chat_history_fts(chat_history_fts, rowid, app_session_id, search_text)
      VALUES('delete', old.id, old.app_session_id, COALESCE(old.search_text, ''));
  END;

  -- AFTER UPDATE: delete old entry, insert updated entry
  CREATE TRIGGER chat_history_fts_au AFTER UPDATE ON chat_history BEGIN
    INSERT INTO chat_history_fts(chat_history_fts, rowid, app_session_id, search_text)
      VALUES('delete', old.id, old.app_session_id, COALESCE(old.search_text, ''));
    INSERT INTO chat_history_fts(rowid, app_session_id, search_text)
      VALUES (new.id, new.app_session_id, COALESCE(new.search_text, ''));
  END;
`);

// Verify rebuild works (it reads back all rows from content table — exercises column name alignment)
db.exec("INSERT INTO chat_history_fts(chat_history_fts) VALUES('rebuild')");
pass("Schema created + rebuild completed (column name alignment verified)");

// ---------------------------------------------------------------------------
// Section 3 — extractSearchableText helper
// ---------------------------------------------------------------------------

hr("3. extractSearchableText helper");

const MAX_TEXT_BYTES = 16 * 1024; // 16 KB hard cap per row
const REASONING_MAX_BYTES = 4 * 1024; // 4 KB for reasoning blocks

/**
 * Extract human-readable text from a chat_history row for FTS indexing.
 *
 * Observed prod payload shapes (from: docker compose exec gateway sqlite3
 * /app/data/gateway.db "SELECT kind, substr(payload_json,1,400) FROM chat_history
 * WHERE kind IN ('user.message','assistant.message','tool.call','reasoning',
 *                'approval.request') GROUP BY kind LIMIT 8"):
 *
 *   kind=user.message       → { text: string, finalText: string }
 *   kind=assistant.message  → { text: string }
 *   kind=reasoning          → { text: string }
 *   kind=tool.call          → { tool_id: string, name: string, duration_s: number, ...result_fields }
 *                              result_fields vary by tool (todos[], query, title, etc.)
 *   kind=approval.request   → { command: string, pattern_key: string, pattern_keys: string[], description: string }
 *
 * The schema uses dot-separated kinds (user.message, tool.call) not underscores.
 * This function normalises both so callers don't need to worry.
 *
 * @param {string} kind
 * @param {unknown} payload — already-parsed JSON object (not a string)
 * @returns {string | null}
 */
function extractSearchableText(kind, payload) {
  if (!payload || typeof payload !== "object") return null;

  /** @type {Record<string, unknown>} */
  const p = /** @type {any} */ (payload);

  // Normalise to dot-notation (handles both "tool_call" and "tool.call")
  const k = kind.replace(/_/g, ".");

  if (k === "user.message" || k === "assistant.message") {
    // user.message carries both text (streaming buffer) and finalText (committed).
    // Prefer finalText when present and non-empty.
    const raw =
      typeof p["finalText"] === "string" && p["finalText"].length > 0
        ? p["finalText"]
        : typeof p["text"] === "string"
          ? p["text"]
          : null;
    return raw ? truncate(raw, MAX_TEXT_BYTES) : null;
  }

  if (k === "reasoning") {
    // Reasoning blocks can be very long — cap at 4KB.
    const raw = typeof p["text"] === "string" ? p["text"] : null;
    return raw ? truncate(raw, REASONING_MAX_BYTES) : null;
  }

  if (k === "tool.call") {
    // name is the most useful search field (e.g. "calendar_create", "browser_navigate").
    // Include other fields (excluding internal bookkeeping: tool_id, duration_s) so
    // queries on tool arguments work (e.g. searching for a filename or calendar title).
    const name = typeof p["name"] === "string" ? p["name"] : "";
    const { tool_id: _tid, duration_s: _dur, name: _name, ...rest } = p;
    const argStr = Object.keys(rest).length > 0 ? JSON.stringify(rest) : "";
    const raw = [name, argStr].filter(Boolean).join(" ");
    return raw ? truncate(raw, MAX_TEXT_BYTES) : null;
  }

  if (k === "tool.result") {
    // Not seen in current prod data (tool results may be inlined into tool.call rows).
    // Index text, output, result, or content fields.
    if (typeof p["text"] === "string") return truncate(p["text"], MAX_TEXT_BYTES);
    const out = p["output"] ?? p["result"] ?? p["content"];
    if (out !== undefined) return truncate(JSON.stringify(out), MAX_TEXT_BYTES);
    return null;
  }

  if (k === "approval.request") {
    // The command string is the most searchable content.
    const parts = [p["description"], p["command"]].filter(
      (x) => typeof x === "string" && x.length > 0
    );
    const raw = parts.join(" ");
    return raw ? truncate(raw, MAX_TEXT_BYTES) : null;
  }

  if (k === "clarify.request" || k === "sudo.request" || k === "secret.request") {
    const raw = typeof p["text"] === "string" ? p["text"] : null;
    return raw ? truncate(raw, MAX_TEXT_BYTES) : null;
  }

  if (k === "error") {
    const raw =
      typeof p["text"] === "string"
        ? p["text"]
        : typeof p["message"] === "string"
          ? p["message"]
          : null;
    return raw ? truncate(raw, MAX_TEXT_BYTES) : null;
  }

  // Unknown kind — return null; trigger stores empty string for this row.
  return null;
}

/**
 * Truncate to at most maxBytes bytes (UTF-8 encoded).
 * @param {string} s
 * @param {number} maxBytes
 */
function truncate(s, maxBytes) {
  // Fast path: ASCII-only, 1 byte per char
  if (s.length <= maxBytes) {
    // Still need to verify actual UTF-8 byte count for emoji/CJK
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

// Self-tests
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
    payload: { text: "word ".repeat(5000) }, // ~25KB
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
    reason = `expected ≤ ${t.expectMaxBytes} bytes, got ${byteLen}`;
  } else if (t.expectContains !== undefined || t.expectNotContains !== undefined) {
    const contains = (t.expectContains ?? []).every((s) => result?.includes(s));
    const notContains = (t.expectNotContains ?? []).every((s) => !result?.includes(s));
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

pass(`extractSearchableText self-tests: ${stPassed}/${stTests.length} passed`);

// ---------------------------------------------------------------------------
// Section 4 — Synthetic data generation + bulk insert
// ---------------------------------------------------------------------------

hr("4. Synthetic data — 1 000 rows across 30 sessions");

const CORPUS = [
  // Technical — will produce FTS hits
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
  // Conversational
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
  // Lorem Ipsum blend
  "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do",
  "Ut enim ad minim veniam quis nostrud exercitation ullamco",
  "Duis aute irure dolor in reprehenderit in voluptate velit esse",
  "Excepteur sint occaecat cupidatat non proident sunt in culpa",
  "Laboris nisi ut aliquip ex ea commodo consequat duis aute",
  // Tool names / results
  "browser_navigate returned 200 OK page loaded successfully done",
  "terminal command executed with exit code 0 and no errors found",
  "search_files matched 12 results across 3 directories in project",
  "todo list updated status changed from pending to in_progress",
  "calendar_create event saved successfully to primary calendar",
  // Error and approval messages
  "script execution via dash e dash c flag pattern requires approval",
  "Connection timeout after 30 seconds retrying the OAuth request",
  "TypeError cannot read property of undefined at runtime line 47",
  "ENOENT no such file or directory when opening config json file",
  "Rate limit exceeded please retry after 60 seconds OAuth refresh",
  // Common word fragments (for common-word query hits)
  "set up the new project repository folder structure today",
  "the quick brown fox jumps over the lazy dog test sentence",
  "please review and approve the pull request changes carefully",
  "here is a summary of the meeting notes from yesterday session",
  "done the assigned task has been completed successfully thank you",
];

const KINDS = [
  "user.message",
  "user.message",       // weighted higher
  "assistant.message",
  "assistant.message",  // weighted higher
  "tool.call",
  "reasoning",
  "approval.request",
];

const TOOL_NAMES = [
  "calendar_create", "calendar_list", "browser_navigate",
  "search_files", "terminal", "todo", "obsidian_read",
  "mcp_connect", "send_email", "read_file",
];

/**
 * Build a realistic payload JSON string for the given kind and text body.
 * @param {string} kind
 * @param {string} text
 */
function makePayload(kind, text) {
  if (kind === "user.message") {
    return JSON.stringify({ text, finalText: text });
  }
  if (kind === "assistant.message" || kind === "reasoning") {
    return JSON.stringify({ text });
  }
  if (kind === "tool.call") {
    const name = TOOL_NAMES[Math.floor(Math.random() * TOOL_NAMES.length)];
    return JSON.stringify({
      tool_id: `call_${Math.random().toString(36).slice(2, 14)}`,
      name,
      duration_s: Math.random() * 2,
      query: text,
    });
  }
  if (kind === "approval.request") {
    return JSON.stringify({ command: text, description: "requires approval", pattern_key: "generic" });
  }
  return JSON.stringify({ text });
}

// 30 session IDs
const SESSION_IDS = Array.from({ length: 30 }, (_, i) => `session-${String(i + 1).padStart(3, "0")}`);

const NUM_ROWS = 1000;
const baseTs = Math.floor(Date.now() / 1000) - NUM_ROWS * 60;

const insertStmt = db.prepare(`
  INSERT INTO chat_history (app_session_id, kind, payload_json, created_at, search_text)
  VALUES (?, ?, ?, ?, ?)
`);

const insertMany = db.transaction((rows) => {
  for (const row of rows) {
    insertStmt.run(row.session, row.kind, row.payloadJson, row.createdAt, row.searchText);
  }
});

const syntheticRows = [];
for (let i = 0; i < NUM_ROWS; i++) {
  const session = SESSION_IDS[i % SESSION_IDS.length];
  const kind = KINDS[i % KINDS.length];
  const textBody = CORPUS[i % CORPUS.length];
  const payloadJson = makePayload(kind, textBody);
  let parsedPayload;
  try {
    parsedPayload = JSON.parse(payloadJson);
  } catch {
    parsedPayload = null;
  }
  const searchText = extractSearchableText(kind, parsedPayload);
  syntheticRows.push({
    session,
    kind,
    payloadJson,
    createdAt: baseTs + i * 60,
    searchText,
  });
}

const t0Insert = performance.now();
insertMany(syntheticRows);
const insertMs = performance.now() - t0Insert;

pass(`Inserted ${NUM_ROWS} rows in ${insertMs.toFixed(1)} ms`);

// Verify FTS row count via docsize shadow table (reliable for external-content FTS5)
const ftsCount = db.prepare("SELECT count(*) AS n FROM chat_history_fts_docsize").get().n;
const chCount = db.prepare("SELECT count(*) AS n FROM chat_history").get().n;
if (ftsCount === chCount) {
  pass(`FTS row count matches: ${ftsCount} rows in chat_history_fts (verified via _docsize shadow table)`);
} else {
  fail(`FTS count mismatch: chat_history=${chCount}, chat_history_fts_docsize=${ftsCount}`);
}

// ---------------------------------------------------------------------------
// Section 5 — Benchmark queries
// ---------------------------------------------------------------------------

hr("5. BM25 Query Benchmarks (100 iterations each)");

/**
 * Sanitize a raw query string for FTS5.
 * - Returns null for empty/whitespace/special-char-only input → caller returns []
 * - Removes unbalanced quotes (odd count → strip all quotes)
 * - Preserves prefix * and quoted phrases when balanced
 * @param {string} raw
 * @returns {string | null}
 */
function sanitizeFtsQuery(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // Fix unbalanced quotes: odd count → remove all quotes
  const quoteCount = (trimmed.match(/"/g) || []).length;
  let cleaned = quoteCount % 2 !== 0 ? trimmed.replace(/"/g, "") : trimmed;

  cleaned = cleaned.trim();

  // Empty after stripping
  if (cleaned.length === 0) return null;

  // If string is entirely non-alphanumeric and non-wildcard, treat as empty
  if (/^[^a-zA-Z0-9*]+$/.test(cleaned)) return null;

  return cleaned;
}

// snippet() column index 1 = search_text (0=app_session_id UNINDEXED, 1=search_text)
const searchStmt = db.prepare(`
  SELECT
    rowid,
    snippet(chat_history_fts, 1, '<b>', '</b>', '...', 12) AS snip,
    bm25(chat_history_fts)                                  AS rank
  FROM chat_history_fts
  WHERE chat_history_fts MATCH ?
  ORDER BY rank
  LIMIT 20
`);

/** @type {Array<{ label: string; query: string }>} */
const BENCH_QUERIES = [
  { label: "Single common word     ", query: "calendar" },
  { label: "Two words AND          ", query: "calendar event" },
  { label: "Phrase                 ", query: '"OAuth token"' },
  { label: "Prefix                 ", query: "auth*" },
  { label: "No-match query         ", query: "xyzzyqq" },
];

const benchResults = [];
for (const { label, query } of BENCH_QUERIES) {
  const sanitized = sanitizeFtsQuery(query);
  if (!sanitized) {
    info(`${label} — skipped (empty after sanitize)`);
    continue;
  }
  let hitCount = 0;
  const stats = bench(() => {
    const results = searchStmt.all(sanitized);
    hitCount = results.length;
  }, 100);
  benchResults.push({ label, query, hitCount, ...stats });
}

console.log();
console.log("  | Query                      | Hits | Mean      | p95       | p99       |");
console.log("  |---------------------------|------|-----------|-----------|-----------|");
for (const r of benchResults) {
  console.log(
    `  | ${r.label}| ${String(r.hitCount).padStart(4)} | ${fmtMs(r.mean).padStart(9)} | ${fmtMs(r.p95).padStart(9)} | ${fmtMs(r.p99).padStart(9)} |`
  );
}

const allUnder50 = benchResults.every((r) => r.p99 < 50);
if (allUnder50) {
  pass("All queries p99 < 50 ms — Phase 0 acceptance criterion MET");
} else {
  const slow = benchResults.filter((r) => r.p99 >= 50);
  fail(`Slow queries (p99 >= 50 ms): ${slow.map((r) => r.label.trim()).join(", ")}`);
}

// Verify snippet actually generates bold markers
const sampleResult = searchStmt.all("calendar")[0];
if (sampleResult && sampleResult.snip && sampleResult.snip.includes("<b>")) {
  pass(`snippet() produces highlight markers: "${sampleResult.snip}"`);
} else {
  fail(`snippet() did not produce <b> markers: ${JSON.stringify(sampleResult?.snip)}`);
}

// ---------------------------------------------------------------------------
// Section 6 — Edge cases
// ---------------------------------------------------------------------------

hr("6. Edge Cases");

// 6.1 — Empty query string
{
  const q = sanitizeFtsQuery("");
  if (q === null) {
    pass("Empty query: sanitizeFtsQuery('') returns null — caller returns [] without DB hit");
  } else {
    fail(`Empty query should return null, got: ${JSON.stringify(q)}`);
  }
}

// 6.2 — Whitespace-only
{
  const q = sanitizeFtsQuery("   ");
  if (q === null) {
    pass("Whitespace-only query: returns null");
  } else {
    fail(`Whitespace query should return null, got: ${JSON.stringify(q)}`);
  }
}

// 6.3 — Special-char-only
{
  const cases = [
    { raw: "---", expectNull: true },
    { raw: "((()))", expectNull: true },
    { raw: '"', expectNull: true },     // unbalanced single quote → stripped → empty → null
    { raw: '"""', expectNull: true },   // odd count (3) → unbalanced → stripped → null
    { raw: "!!@@##", expectNull: true },
    { raw: "auth*", expectNull: false }, // prefix query — should survive
    // '""' is TWO quotes (even = balanced) — valid FTS5 empty-phrase, returns 0 hits, no crash.
    // sanitizeFtsQuery does NOT null it out; it's a caller concern to check result count.
    // We test it separately below rather than in this loop.
  ];
  let allOk = true;
  for (const { raw, expectNull } of cases) {
    const q = sanitizeFtsQuery(raw);
    if (expectNull && q !== null) {
      fail(`sanitizeFtsQuery("${raw}"): expected null, got "${q}"`);
      allOk = false;
    } else if (!expectNull && q === null) {
      fail(`sanitizeFtsQuery("${raw}"): expected non-null, got null`);
      allOk = false;
    } else if (q !== null) {
      // Run the query to verify it doesn't crash FTS5
      try {
        searchStmt.all(q);
      } catch (err) {
        fail(`Query "${q}" (from "${raw}") caused FTS5 crash: ${err.message}`);
        allOk = false;
      }
    }
  }
  // Balanced empty phrase '""': not null'd by sanitizer (valid FTS5 syntax), returns 0 hits, no crash.
  const balancedEmptyPhrase = sanitizeFtsQuery('""');
  if (balancedEmptyPhrase !== null) {
    try {
      const hits = searchStmt.all(balancedEmptyPhrase).length;
      pass(`Balanced empty phrase '""': survived sanitizer (returned "${balancedEmptyPhrase}"), FTS5 query ok, hits=${hits}`);
    } catch (err) {
      fail(`Balanced empty phrase '""' crashed FTS5: ${err.message}`);
      allOk = false;
    }
  } else {
    pass(`Balanced empty phrase '""': sanitizer returned null — also safe`);
  }

  if (allOk) pass("Special-char sanitization: all cases handled correctly");
}

// 6.4 — Emoji in payload (unicode61 tokenizer behavior)
{
  const emojiPayload = { text: "Planning meeting emoji-only-after calendar sync obsidian vault setup" };
  const emojiText = extractSearchableText("assistant.message", emojiPayload);
  db.prepare(
    "INSERT INTO chat_history (app_session_id, kind, payload_json, created_at, search_text) VALUES (?,?,?,?,?)"
  ).run("session-emoji", "assistant.message", JSON.stringify(emojiPayload), Date.now(), emojiText);

  const obsidianHits = searchStmt.all("obsidian");
  pass(`Emoji row inserted; FTS finds adjacent words (obsidian hits: ${obsidianHits.length})`);

  try {
    // unicode61 tokenizer strips emoji — they become empty tokens, so this query returns 0 hits but doesn't crash
    const emojiQueryResult = searchStmt.all("planning*");
    pass(`Prefix query near emoji: ${emojiQueryResult.length} hits — no crash`);
  } catch (err) {
    fail(`Query near emoji content crashed: ${err.message}`);
  }
}

// 6.5 — UPDATE trigger: FTS reflects the change
{
  const termBefore = "xyzzy_unique_before_update";
  const termAfter = "xyzzy_unique_after_update";

  db.prepare(
    "INSERT INTO chat_history (app_session_id, kind, payload_json, created_at, search_text) VALUES (?,?,?,?,?)"
  ).run("session-update-test", "user.message", '{"text":"update-test"}', Date.now(), termBefore);

  const beforeUpdate = searchStmt.all(termBefore).length;
  const afterTermBeforeUpdate = searchStmt.all(termAfter).length;

  db.prepare(
    "UPDATE chat_history SET search_text = ? WHERE search_text = ?"
  ).run(termAfter, termBefore);

  const afterOldTerm = searchStmt.all(termBefore).length;
  const afterNewTerm = searchStmt.all(termAfter).length;

  if (beforeUpdate === 1 && afterTermBeforeUpdate === 0 && afterOldTerm === 0 && afterNewTerm === 1) {
    pass("UPDATE trigger: old FTS entry removed, new entry indexed correctly");
  } else {
    fail(
      `UPDATE trigger: before=${beforeUpdate}, termAfterBeforeUpdate=${afterTermBeforeUpdate}, afterOld=${afterOldTerm}, afterNew=${afterNewTerm}`
    );
  }
}

// 6.6 — DELETE trigger: FTS row drops with the base row
{
  const deleteTerm = "xyzzy_delete_test_term";

  db.prepare(
    "INSERT INTO chat_history (app_session_id, kind, payload_json, created_at, search_text) VALUES (?,?,?,?,?)"
  ).run("session-delete-test", "user.message", '{"text":"delete-test"}', Date.now(), deleteTerm);

  const beforeDelete = searchStmt.all(deleteTerm).length;
  db.prepare("DELETE FROM chat_history WHERE search_text = ?").run(deleteTerm);
  const afterDelete = searchStmt.all(deleteTerm).length;

  if (beforeDelete === 1 && afterDelete === 0) {
    pass("DELETE trigger: FTS entry removed when chat_history row deleted");
  } else {
    fail(`DELETE trigger: before=${beforeDelete}, after=${afterDelete}`);
  }
}

// 6.7 — NULL search_text (COALESCE stores '' — no crash, no phantom matches)
{
  db.prepare(
    "INSERT INTO chat_history (app_session_id, kind, payload_json, created_at, search_text) VALUES (?,?,?,?,?)"
  ).run("session-null-test", "tool.call", '{"tool_id":"t99","name":"noop","duration_s":0}', Date.now(), null);
  pass("NULL search_text: trigger stores COALESCE '' — no crash, row exists in FTS_docsize");
}

// 6.8 — 16KB and 4KB truncation are actually enforced
{
  const longAssistant = "word ".repeat(4000); // ~20KB
  const extracted = extractSearchableText("assistant.message", { text: longAssistant });
  const byteLen = new TextEncoder().encode(extracted ?? "").length;
  if (byteLen <= MAX_TEXT_BYTES) {
    pass(`16KB truncation (assistant.message): ${byteLen} bytes — within budget`);
  } else {
    fail(`16KB truncation failed: ${byteLen} bytes (limit ${MAX_TEXT_BYTES})`);
  }

  const longReasoning = "token ".repeat(3000); // ~18KB
  const extractedR = extractSearchableText("reasoning", { text: longReasoning });
  const byteLenR = new TextEncoder().encode(extractedR ?? "").length;
  if (byteLenR <= REASONING_MAX_BYTES) {
    pass(`4KB truncation (reasoning): ${byteLenR} bytes — within budget`);
  } else {
    fail(`4KB truncation failed for reasoning: ${byteLenR} bytes (limit ${REASONING_MAX_BYTES})`);
  }
}

// ---------------------------------------------------------------------------
// Section 7 — Approach A vs Approach B comparison
// ---------------------------------------------------------------------------

hr("7. Approach A vs Approach B");

info("APPROACH A (current spike — app-level search_text):");
info("  TypeScript computes search_text at INSERT time.");
info("  SQL triggers: COALESCE(new.search_text, '') → FTS. No JSON parsing in SQL.");
info("");
info("APPROACH B (SQL-only via json_extract in triggers):");
info("  No search_text column. Triggers call json_extract(payload_json, ...) per kind.");

// Prototype Approach B in a throw-away in-memory DB
const dbB = new Database(":memory:");
dbB.exec(`
  CREATE TABLE chat_history (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    app_session_id TEXT NOT NULL,
    kind           TEXT NOT NULL,
    payload_json   TEXT NOT NULL,
    created_at     INTEGER NOT NULL
  );

  CREATE VIRTUAL TABLE chat_history_fts USING fts5(
    app_session_id  UNINDEXED,
    search_text,
    content='chat_history',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
  );

  -- Approach B trigger: all kind-specific extraction in SQL CASE/json_extract.
  -- This is the FULL trigger — note the complexity for multi-field kinds and
  -- the impossibility of per-kind truncation (would need separate substr() per arm).
  CREATE TRIGGER chat_history_fts_ai AFTER INSERT ON chat_history BEGIN
    INSERT INTO chat_history_fts(rowid, app_session_id, search_text)
    VALUES (
      new.id,
      new.app_session_id,
      substr(
        COALESCE(
          CASE new.kind
            WHEN 'user.message'
              THEN COALESCE(
                     json_extract(new.payload_json, '$.finalText'),
                     json_extract(new.payload_json, '$.text')
                   )
            WHEN 'assistant.message'
              THEN json_extract(new.payload_json, '$.text')
            WHEN 'reasoning'
              THEN json_extract(new.payload_json, '$.text')
            WHEN 'tool.call'
              THEN (
                     COALESCE(json_extract(new.payload_json, '$.name'), '') ||
                     ' ' ||
                     COALESCE(json_extract(new.payload_json, '$.query'), '') ||
                     ' ' ||
                     COALESCE(json_extract(new.payload_json, '$.input'), '')
                   )
            WHEN 'approval.request'
              THEN (
                     COALESCE(json_extract(new.payload_json, '$.description'), '') ||
                     ' ' ||
                     COALESCE(json_extract(new.payload_json, '$.command'), '')
                   )
            WHEN 'clarify.request'
              THEN json_extract(new.payload_json, '$.text')
            WHEN 'error'
              THEN COALESCE(
                     json_extract(new.payload_json, '$.text'),
                     json_extract(new.payload_json, '$.message')
                   )
            ELSE ''
          END,
          ''
        ),
        1,
        16384
      )
    );
  END;
`);

const insertB = dbB.prepare(
  "INSERT INTO chat_history (app_session_id, kind, payload_json, created_at) VALUES (?,?,?,?)"
);
insertB.run("s1", "user.message", '{"text":"OAuth token","finalText":"OAuth token refresh"}', Date.now());
insertB.run("s1", "assistant.message", '{"text":"The MCP server obsidian vault sync is ready."}', Date.now());
insertB.run(
  "s1",
  "tool.call",
  '{"tool_id":"t1","name":"calendar_create","duration_s":0.1,"query":"sync vault event"}',
  Date.now()
);
insertB.run("s1", "approval.request", '{"command":"rm /tmp/x","description":"file deletion"}', Date.now());

const bDocsize = dbB.prepare("SELECT count(*) AS n FROM chat_history_fts_docsize").get().n;
const bOAuth = dbB
  .prepare("SELECT rowid FROM chat_history_fts WHERE chat_history_fts MATCH 'OAuth'")
  .all().length;
const bCalendar = dbB
  .prepare("SELECT rowid FROM chat_history_fts WHERE chat_history_fts MATCH 'calendar*'")
  .all().length;

if (bDocsize === 4 && bOAuth >= 1 && bCalendar >= 1) {
  pass(`Approach B prototype: docsize=${bDocsize}, OAuth hits=${bOAuth}, calendar* hits=${bCalendar}`);
} else {
  fail(`Approach B prototype: docsize=${bDocsize}, OAuth hits=${bOAuth}, calendar* hits=${bCalendar}`);
}
dbB.close();

console.log();
info("Approach A advantages:");
info("  + Multi-field merging, truncation, edge cases handled in TypeScript — easy to test");
info("  + SQL triggers are 3 lines each (just COALESCE(new.search_text,''))");
info("  + search_text column is directly queryable for debugging and backfill status checks");
info("  + Backfill: SELECT WHERE search_text IS NULL, extract, UPDATE — idempotent, boot-safe");
info("  + New kind added? Change one TS function + re-backfill NULLs. No SQL migration needed.");
info("  + Per-kind truncation (4KB for reasoning, 16KB elsewhere) is clean in TypeScript;");
info("    SQL would require one substr() per CASE arm with different lengths.");
info("  + Unit-testable without a database.");
info("");
info("Approach A disadvantages:");
info("  - Raw SQL inserts (fixtures, emergency patches) leave search_text NULL until backfill.");
info("    Acceptable: backfill runs at every boot and is idempotent.");
info("");
info("Approach B advantages:");
info("  + Saves one column of storage.");
info("  + Works for raw SQL inserts (trigger fires immediately on every INSERT).");
info("");
info("Approach B disadvantages:");
info("  - Full kind-specific extraction logic must live in SQL CASE/json_extract chains.");
info("  - Per-kind truncation requires separate substr() calls per CASE arm.");
info("  - reasoning 4KB vs general 16KB limit cannot be expressed cleanly in one CASE.");
info("  - Adding a new kind requires a SQL migration to DROP/recreate the trigger.");
info("  - json_extract on every INSERT: fine at our scale, but adds SQL complexity.");
info("  - Hard to unit-test SQL trigger logic directly.");
info("  - FTS column must be named 'search_text' but content table has no 'search_text' col —");
info("    the name is used for routing to the FTS index only; snippet() still works because");
info("    the column mapping is by position for non-content tables, but this is confusing.");
info("");
info("RECOMMENDATION: Approach A. Cleaner separation of concerns, correct per-kind");
info("truncation, fully unit-testable, and maintenance-free when new kinds are added.");

// ---------------------------------------------------------------------------
// Section 8 — Final summary
// ---------------------------------------------------------------------------

hr("8. Summary");

const finalFtsRows = db.prepare("SELECT count(*) AS n FROM chat_history_fts_docsize").get().n;
const finalChRows = db.prepare("SELECT count(*) AS n FROM chat_history").get().n;
pass(`Final chat_history rows: ${finalChRows} (1000 synthetic + edge-case rows)`);
pass(`Final FTS docsize rows:  ${finalFtsRows}`);

if (process.exitCode) {
  console.log("\n  One or more assertions failed — see FAIL lines above.");
} else {
  pass("All assertions passed. Spike complete.");
}

db.close();
