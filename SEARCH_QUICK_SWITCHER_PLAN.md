# Search Across All Chats + Quick Switcher

**Status:** Phase 0 complete. Phase 1 green-lit. Captured 2026-05-05. Open questions resolved 2026-05-05 (see §6 — Locked decisions).

Spotlight-style fuzzy + full-text search across every chat session. Trigger from anywhere in the app. Tap a result → open that chat scrolled to the matched message.

---

## 1. Goals

- **Find old conversations fast.** Today the only way to find a chat is to scroll the list and recognize the title. With dozens of sessions, that fails.
- **Spotlight UX.** A single keystroke / gesture opens a modal. Type → instant results. Arrow / tap → jump.
- **Search both titles and content.** Title-only is half-useful. Content match is what unlocks recall.
- **Deep-link to the matched message.** Don't just open the chat — scroll to the message that matched.
- **Stretch: include skills, cron jobs, inbox items** in the switcher so it doubles as universal nav.

## 2. Non-goals (v1)

- **Real-time streaming search.** A 200ms debounce is fine; don't optimize.
- **Operator syntax (`from:`, `before:`, `tool:` filters)** — defer to v2.
- **Cross-session vector / embedding search.** SQLite FTS5 BM25 ranking is plenty for personal scale.
- **Search inside attachments** (PDFs, images). Their text lives in `derived_artifacts` already; can layer in later.

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ Mobile app                                                          │
│  ┌──────────────────┐    trigger from anywhere                      │
│  │ Quick Switcher   │◄────────  long-press tab bar /                │
│  │ (modal overlay)  │           swipe-down from chat list /         │
│  │                  │           Cmd+K (iPad keyboard)               │
│  │ ┌──────────────┐ │                                                │
│  │ │ Search bar   │ │ debounced input → fetch                       │
│  │ ├──────────────┤ │                                                │
│  │ │ Sessions     │ │                                                │
│  │ │ ─ session A  │◄┼──── highlighted snippet                       │
│  │ │ ─ session B  │ │                                                │
│  │ ├──────────────┤ │                                                │
│  │ │ Skills (v2)  │ │                                                │
│  │ │ Cron (v2)    │ │                                                │
│  │ └──────────────┘ │                                                │
│  └────────┬─────────┘                                                │
│           │ tap                                                      │
│           ▼                                                          │
│  router.push("/chat/<id>?messageId=<row>")                          │
│           ↓                                                          │
│  Chat screen scrolls to messageId on mount                          │
└─────────────────────────────────────────────────────────────────────┘
                          │
                          │ HTTP
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Gateway (Fastify)                                                   │
│  GET /search?q=foo&limit=20&cursor=...                              │
│  ┌──────────────────────────┐                                       │
│  │ chat_history             │                                       │
│  │  ↓ trigger on insert     │                                       │
│  │ chat_history_fts (FTS5)  │ ← virtual table, BM25 ranking         │
│  └──────────────────────────┘                                       │
│  Returns: [{ session_id, message_id, role, snippet, score, ts }]    │
└─────────────────────────────────────────────────────────────────────┘
```

### Why SQLite FTS5

- We already use SQLite (better-sqlite3 + drizzle). FTS5 is built-in, no new dependency.
- BM25 ranking is good enough for personal scale (single-user, ~100s-1000s of sessions, ~10k-100k messages).
- Schema migration is a single virtual-table CREATE + a backfill INSERT. Triggers keep it in sync forward.
- Snippet generation is built-in (`snippet()` function).

### Components

| Layer | Path | Purpose |
|---|---|---|
| Schema | `backend/src/db/schema.ts` + new migration | `chat_history_fts` virtual table; triggers wire it to `chat_history` |
| Indexer | `backend/src/db/indexer.ts` (new) | One-shot backfill on first deploy: read all `chat_history` rows, insert into FTS table |
| Search route | `backend/src/routes/search.ts` (new) | `GET /search?q=...` with auth, BM25 rank, snippet, pagination |
| Search types | `backend/src/types/search.ts` + `frontend/src/api/search.ts` | Shared shapes |
| Frontend hook | `frontend/src/search/useSearch.ts` | Debounced fetcher, result state, recent queries cache |
| Switcher UI | `frontend/src/search/QuickSwitcher.tsx` | Modal overlay with bar + result list |
| Trigger | Tab bar long-press, swipe-down on chat list, Cmd+K | `useSwitcherShortcut.ts` |
| Deep-link consumer | `frontend/app/(app)/(chats)/chat/[id].tsx` (extend) | Read `messageId` query param → scroll to row on mount |

---

## 4. Phases

### Phase 0 spike findings (completed 2026-05-05)

Full report in commit message + `backend/spike-search/spike.mjs`. Key results:

| Query | Mean | p95 | p99 |
|---|---|---|---|
| Single word (`calendar`) | 0.084 ms | 0.097 ms | 0.169 ms |
| AND (`calendar event`) | 0.093 ms | 0.104 ms | 0.166 ms |
| Phrase (`"OAuth token"`) | 0.062 ms | 0.072 ms | 0.087 ms |
| Prefix (`auth*`) | 0.049 ms | 0.058 ms | 0.061 ms |
| No-match | 0.006 ms | 0.009 ms | 0.016 ms |

All queries p99 well under the 50ms acceptance bar — orders of magnitude of
headroom. **Phase 1 green-lit** with the column-name + snippet-index +
docsize-count corrections folded in above.

**Schema decision: Approach A** (TypeScript writes `search_text` at insert
time; SQL triggers mirror it to FTS). Three reasons:
- Per-kind truncation (reasoning 4KB, others 16KB) is awkward in pure SQL
- New `kind` values don't need a migration; just update the helper
- Backfill is `WHERE search_text IS NULL` — trivial
- Helper is unit-testable as a pure function, no DB needed

### Phase 0 — Spike + scope vetting (1-2 hours) — COMPLETE

**Goal:** confirm FTS5 + better-sqlite3 + drizzle work cleanly together; decide schema details.

Tasks:
- Verify `better-sqlite3` (already in deps) builds with FTS5 in our Docker images. It does by default — but our build is from source, so confirm.
- Spike: create a tiny test DB, populate with 1k synthetic chat messages, build FTS index, run BM25 query, time it. Want < 50ms for typical queries.
- Decide: index `chat_history.payloadJson` as-is (extracts text via FTS5's `tokenize='unicode61 remove_diacritics 2'`) OR pre-extract a `searchable_text` column at insert time? The latter is more work but avoids JSON parsing in FTS triggers.
- Decide: include assistant messages, user messages, tool calls/results, or all? Start with user + assistant `text` fields; add tool stuff in v2.

Acceptance: 1k-row FTS query under 50ms, schema decision made.

Files: throwaway `backend/spike-search/` — don't commit.

---

### Phase 1 — Backend schema + indexer (4-5 hours)

#### Drizzle migration

`backend/src/db/migrations/000X_search_fts.sql`:

```sql
-- Add search_text column populated at insert time by the app (Approach A).
-- See backend/spike-search/spike.mjs for the rationale (Approach A vs B).
ALTER TABLE chat_history ADD COLUMN search_text TEXT;

-- FTS5 virtual table mirroring chat_history.search_text.
--
-- IMPORTANT: column names MUST match chat_history columns exactly. FTS5
-- external-content tables map virtual cols → content cols by name. A
-- mismatch causes "no such column" errors on rebuild + snippet().
CREATE VIRTUAL TABLE chat_history_fts USING fts5(
  app_session_id UNINDEXED,   -- matches chat_history.app_session_id
  search_text,                -- matches chat_history.search_text
  content='chat_history',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

-- Triggers keep FTS in sync. The actual text extraction is in the app code
-- (see indexer.ts → extractSearchableText). Triggers just mirror search_text.
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
```

**Counting FTS rows:** `SELECT count(*) FROM chat_history_fts` does NOT work on
external-content tables. Use `SELECT count(*) FROM chat_history_fts_docsize`
in the boot-time backfill verification.

#### Schema update

`backend/src/db/schema.ts`:

Add `searchText: text("search_text")` to `chatHistory`.

#### Backfill indexer

`backend/src/db/indexer.ts` (new):

```ts
export async function backfillSearchIndex(db: Db, log: AppLogger): Promise<void> {
  // 1. Read all chat_history rows where search_text IS NULL.
  // 2. For each: parse payload_json, extract human-readable text per kind.
  // 3. Drop the AFTER UPDATE trigger temporarily, then either:
  //    a) UPDATE chat_history SET search_text = ? AND directly INSERT INTO
  //       chat_history_fts(rowid, app_session_id, search_text), OR
  //    b) Use INSERT INTO chat_history_fts directly (skips trigger entirely).
  //    Without this, every UPDATE fires delete-then-insert against FTS —
  //    O(2N) FTS operations on first deploy with 100k+ rows.
  // 4. Recreate the AFTER UPDATE trigger after backfill completes.
  // 5. Batch in transactions of 1k rows. Log progress every 5k.
}
```

Run on every server boot (idempotent — only touches rows with `search_text IS NULL`). On first deploy with a populated DB, the trigger-bypass path is critical for perf.

#### Helper: extract text from payload

Per Phase 0 spike's prod-payload survey (see `backend/spike-search/spike.mjs`),
the canonical kind names use **dot notation** (not underscores):

```ts
// chat_history kinds observed in prod + their text shapes:
//   - "user.message"      → { text, finalText } — prefer finalText
//   - "assistant.message" → { text }
//   - "reasoning"         → { text } — can be very long, truncate to 4KB
//   - "tool.call"         → { name, ...tool-specific named fields }
//                           Index `name` + stringify rest minus tool_id/duration_s
//   - "approval.request"  → { description, command, pattern_keys }
//                           Index description + command
//   - "tool.result"       → not seen in prod (folded into tool.call) — handle defensively
//   - other kinds         → { text } if present, else null
//
// Normalize underscores → dots before matching so callers can pass either form.
function extractSearchableText(kind: string, payload: unknown): string | null { ... }
```

All extracted text capped at **16KB** per row (4KB for `reasoning`).

**`tool.call` arg extraction:** depth-1 value walk over the `rest` object (after stripping `tool_id`, `duration_s`, `name`), not `JSON.stringify`. Stringify produces `{"todos":[{"id":"1",...}]}` which leaks structural noise (quotes, brackets) into the FTS tokenizer and balloons the index. A depth-1 walk extracts just string values, joined with spaces — see Phase 0 spike's `extractSearchableText` for the surface, then improve in Phase 1.

```ts
// Phase 1 improvement on top of spike's prototype:
function flattenToolArgs(rest: Record<string, unknown>): string {
  const out: string[] = [];
  for (const v of Object.values(rest)) {
    if (typeof v === "string") out.push(v);
    else if (typeof v === "number" || typeof v === "boolean") out.push(String(v));
    else if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === "string") out.push(item);
        else if (item && typeof item === "object") {
          // Walk one level into objects within arrays (e.g. todos: [{content, ...}])
          for (const iv of Object.values(item as Record<string, unknown>)) {
            if (typeof iv === "string") out.push(iv);
          }
        }
      }
    }
    // Skip nested objects deeper than 2 levels (rare; not worth indexing)
  }
  return out.join(" ");
}
```

#### Phase 1 acceptance criteria

The spike validated 1k rows. Phase 1 must additionally verify:

| # | Criterion | How to check |
|---|---|---|
| 1 | Migration applies cleanly via Drizzle's runner | `pnpm db:migrate` on a fresh DB exits 0 |
| 2 | Backfill bypasses trigger overhead on first deploy | Drop+recreate trigger pattern OR direct FTS inserts during backfill |
| 3 | 100k-row synthetic benchmark p99 < 50ms | Extend the spike's bench harness to 100k synthetic rows; report numbers |
| 4 | FTS index disk size measured + documented | `du -sh` against the test DB after 100k bench; log in Phase 1 commit message |
| 5 | Snippet markers are distinctive (not collidable with markdown) | Use `⟨MARK⟩` + `⟨/MARK⟩` (or similar non-HTML strings) in `snippet()` calls. Frontend regex-replaces these exact markers. **NOT `<b>...</b>`** — would collide with assistant markdown bold. |
| 6 | Boot-time log shows "indexed N rows in Mms" once per cold start | Logger output |
| 7 | Verify count via `chat_history_fts_docsize` (NOT `chat_history_fts`) | Acceptance grep |

---

### Phase 2 — Backend search API (2-3 hours)

`backend/src/routes/search.ts`:

```ts
// GET /search?q=...&limit=20&cursor=...
//
// Query:
//   - q: search query (FTS5 syntax — quotes, AND/OR/NOT, prefix*).
//        We sanitize unescaped quotes; otherwise pass through.
//   - limit: 1-50, default 20
//   - cursor: opaque pagination token (encoded rowid + score for next page)
//
// Response:
// {
//   results: [
//     {
//       sessionId: string,
//       sessionTitle: string,
//       messageId: number,        // chat_history.id
//       role: "user" | "assistant" | "tool_call" | "tool_result" | string,
//       snippet: string,          // FTS5 snippet() with <b>...</b> markers
//       createdAt: number,
//       score: number,            // BM25 rank (more negative = better match)
//     },
//     ...
//   ],
//   nextCursor: string | null,
// }
```

Key SQL:

```sql
SELECT
  ch.id          AS message_id,
  ch.app_session_id AS session_id,
  s.title_override AS session_title_override,
  hs.title         AS hermes_title,
  ch.kind          AS role,
  ch.created_at    AS created_at,
  bm25(chat_history_fts) AS rank,
  -- snippet(table, col_idx, ...) — col_idx is 1 (search_text is the 2nd
  -- col, 0=app_session_id, 1=search_text in our schema).
  -- Markers are non-HTML so they can't collide with assistant markdown bold.
  -- Frontend regex-replaces ⟨MARK⟩ + ⟨/MARK⟩ to render highlight spans.
  snippet(chat_history_fts, 1, '⟨MARK⟩', '⟨/MARK⟩', '…', 12) AS snippet
FROM chat_history_fts
JOIN chat_history ch ON ch.id = chat_history_fts.rowid
JOIN app_sessions s ON s.id = ch.app_session_id
LEFT JOIN hermes_sessions hs ON hs.id = s.hermes_session_id
WHERE chat_history_fts MATCH ?
  AND s.user_id = ?
ORDER BY rank
LIMIT ? OFFSET ?;
```

(Note: `app_sessions` joins to scope results to authenticated user. `bm25()` is FTS5's ranking function — lower is better.)

Auth: standard `requireAuth` preHandler (existing pattern).

Rate limit: per-user 10 req / 5 sec (Fastify rate-limit, scope by user_id).

Snippet length: 12 tokens around match, ellipsis on either side.

Edge cases:
- Empty query: return `[]` immediately, don't hit DB.
- Query with only special chars: sanitize to empty → `[]`.
- Query is a single word with no matches: return `[]` cleanly.
- Title-only matches: also include sessions whose `title` matches even if no body content matches.

Acceptance: curl-test with various queries. Sub-100ms p95 on a populated DB.

---

### Phase 3 — Frontend search hook + API client (2 hours)

`frontend/src/api/search.ts`:

```ts
export interface SearchResult {
  sessionId: string;
  sessionTitle: string;
  messageId: number;
  role: string;
  snippet: string;        // contains <b>...</b> markers
  createdAt: number;
  score: number;
}

export interface SearchResponse {
  results: SearchResult[];
  nextCursor: string | null;
}

export async function search(q: string, opts?: { limit?: number; cursor?: string }): Promise<SearchResponse>;
```

`frontend/src/search/useSearch.ts`:

```ts
export interface UseSearchResult {
  query: string;
  setQuery: (q: string) => void;
  results: SearchResult[];
  loading: boolean;
  error: Error | null;
  loadMore: () => void;     // for cursor-based pagination if user scrolls
  clearRecent: () => void;
  recentQueries: string[];  // last N persisted in AsyncStorage
}

export function useSearch(): UseSearchResult;
```

Behavior:
- 200ms debounce on `setQuery`.
- Empty query → results = `[]`, but show `recentQueries` instead.
- Persist last 10 queries to AsyncStorage on submit (i.e., when a result is tapped).
- Cancel in-flight request on new query.

---

### Phase 4 — Quick switcher modal UI (4-5 hours)

`frontend/src/search/QuickSwitcher.tsx`:

```tsx
export interface QuickSwitcherProps {
  visible: boolean;
  onClose: () => void;
}

export function QuickSwitcher({ visible, onClose }: QuickSwitcherProps): React.ReactElement;
```

Layout:
```
┌─ Modal (full-screen, dim backdrop, content card slides up) ─┐
│  ┌─────────────────────────────────────────────────────┐    │
│  │ 🔍  Search across chats…           [✕]              │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  When query is empty:                                        │
│    Recent searches:                                          │
│    ─ "auth refactor"                                         │
│    ─ "obsidian sync"                                         │
│    ─ ...                                                     │
│                                                              │
│  When query has results:                                     │
│    SESSIONS                                                  │
│    ┌─ Auth refactor planning · 2 days ago ────────────┐    │
│    │  ...the new <b>token rotation</b> approach...    │    │
│    └────────────────────────────────────────────────────┘    │
│    ┌─ Hermes integration · last week ───────────────────┐    │
│    │  ...what's the right <b>token</b> path...        │    │
│    └────────────────────────────────────────────────────┘    │
│                                                              │
│    SKILLS (v2 — defer)                                       │
│    CRON   (v2 — defer)                                       │
└──────────────────────────────────────────────────────────────┘
```

Components:
- `<Modal>` from RN, `transparent` + `animationType="slide"`.
- `<TextInput>` with `autoFocus`, search icon prefix, clear (✕) button when text exists.
- Result list: `<FlashList>` (already in project) with `<ResultRow>` items.
- `<ResultRow>` renders session title, formatted relative time, and the snippet with `<b>` markers replaced by `<Text style={styles.bold}>` tags. Tap → close + `router.push(\`/chat/${sessionId}?messageId=${messageId}\`)`.
- Empty state: "Search across all your chats" with a search-icon ghost.
- Loading state: small spinner inline in search bar (no full-screen skeleton).
- Error state: small banner with retry tap.

Visual style: match the existing modal patterns in the app (`ActionSheet`, `BottomSheetModal` from gorhom — see how those are used).

---

### Phase 5 — Trigger integration (2-3 hours)

Three trigger paths, all in v1:

#### 5.1 — Tab bar long-press

In the tab bar component (`frontend/src/components/ui/AppTabBar.tsx` likely), add an `onLongPress` to one of the tab items (most natural: long-press on the active tab, OR long-press on an "always-visible" search icon). Decision in Phase 0.

#### 5.2 — Swipe-down from chat list

In `frontend/app/(app)/(chats)/index.tsx` (or wherever the chats list lives), add a `RefreshControl`-like gesture for swipe-down. Or use a `PanGestureHandler` from `react-native-gesture-handler`. Triggers QuickSwitcher.

#### 5.3 — Cmd+K (iPad with hardware keyboard)

Use `react-native-keyboard-shortcuts` if available, or RN's built-in `useKeyCommand` hook (RN 0.83 has limited support; verify). If neither works cleanly, defer to v2.

#### Mounting

QuickSwitcher mounts at the app root (in `_layout.tsx`) so it floats above all screens. State for `visible` lives in a Zustand store:

```ts
export const useQuickSwitcher = create<{
  visible: boolean;
  open: () => void;
  close: () => void;
}>((set) => ({
  visible: false,
  open: () => set({ visible: true }),
  close: () => set({ visible: false }),
}));
```

---

### Phase 6 — Deep-link to message in chat (3-4 hours)

The chat screen at `frontend/app/(app)/(chats)/chat/[id].tsx` needs to:

1. Read `messageId` query param via `useLocalSearchParams`.
2. After messages load, find the message with that `id` and scroll to it.
3. Briefly highlight the matched message (1.5s background tint).

Implementation:
```ts
const { messageId } = useLocalSearchParams<{ messageId?: string }>();

useEffect(() => {
  if (!messageId) return;
  const targetIndex = messages.findIndex(m => m.id === Number(messageId));
  if (targetIndex < 0) return;
  // scrollToIndex on the FlashList ref. Slight delay for layout.
  setTimeout(() => flashListRef.current?.scrollToIndex({ index: targetIndex, animated: true }), 100);
  // Highlight via flash message id state + 1500ms timeout to clear.
  setHighlightId(Number(messageId));
  setTimeout(() => setHighlightId(null), 1500);
}, [messageId, messages.length]);
```

Highlight: pass `highlightId` to message renderer; row checks `if (id === highlightId) bg = tokens.accentBg` for the duration.

Edge cases:
- Message not yet loaded (long history not paginated): fetch a window around the messageId from the backend. Likely needs a new endpoint `GET /sessions/:id/messages?around=<rowId>&window=20` — or extend existing list endpoint. ~1 hour of additional work.
- Message was deleted: scroll fails gracefully, no highlight, log info.

---

### Phase 7 — Polish + accessibility (2 hours)

- VoiceOver: search bar announces "Search across chats", results announce "Session X, message from Y, content snippet"
- Reduce-motion: skip the slide-up animation; fade only
- Empty-result state: clear "no matches" text, suggest broadening query
- Recent queries: tap to re-run; long-press to delete one
- Keyboard: dismiss on result tap, NOT on backdrop tap (user might be still typing)
- Snippet rendering: `<b>` markers are 100% trusted because they come from the gateway's controlled snippet() call. No XSS surface, but document the assumption.
- Performance: results > 20 items virtualize via FlashList; that's already in the project

---

### Phase 8 — Tests + ship (2 hours)

Manual scenarios on real device:

| # | Scenario | Expected |
|---|---|---|
| 1 | Long-press tab bar (or chosen trigger) | Switcher opens, search bar focused |
| 2 | Type "obsidian" → wait 200ms | 5+ results from past chats with "obsidian" highlighted |
| 3 | Tap a result | Switcher closes, chat opens, scrolled to that message, message highlighted for 1.5s |
| 4 | Empty query → see recent | Last 5 queries listed, tap re-runs |
| 5 | Type quickly, then change query | Old in-flight request cancelled (no flash of stale results) |
| 6 | No matches | "No matches" empty state |
| 7 | Backend down | Banner with retry button |
| 8 | Long history (1000+ messages) | Search returns < 200ms; scroll-to-message works in chat |
| 9 | Special chars in query (`"foo bar"`, `auth*`) | FTS prefix/quote works, no crash |
| 10 | iPad with HW keyboard, Cmd+K | Switcher opens (if Phase 5.3 shipped) |

Then:
- `pnpm build` on backend
- `eas build --profile development --platform ios --local` on frontend
- Smoke-test on phone

---

## 5. Time estimate

| Phase | Hours |
|---|---|
| 0 — Spike | 1-2 |
| 1 — Backend schema + indexer | 4-5 |
| 2 — Backend search API | 2-3 |
| 3 — Frontend hook + API client | 2 |
| 4 — Quick switcher modal | 4-5 |
| 5 — Trigger integration | 2-3 |
| 6 — Deep-link to message | 3-4 |
| 7 — Polish + a11y | 2 |
| 8 — Tests + ship | 2 |
| **Total** | **~22-28 hours** |

About **3-4 focused days**. With 50% buffer for FTS surprises + scroll-to-message edge cases → **~5-6 calendar days**.

---

## 6. Locked decisions (resolved 2026-05-05)

- **D1 — Trigger:** **long-press the active tab + dedicated icon in the chats tab navbar.** Two complementary entry points: long-press is muscle-memory friendly once learned; the icon is discoverable. Swipe-down + Cmd+K on iPad both deferred to v2 (extra surface area, marginal value for v1).
- **D2 — v1 scope:** **Sessions only.** Search inside chat content; results are messages within sessions. Skills + cron + inbox in v2 — each is a ~1-hour add-on once the framework exists.
- **D3 — Recent queries:** **persist last 10 to AsyncStorage** (on-device, no backend storage). User can clear from a long-press menu on the recent-queries list. No cross-device sync.
- **D4 — Highlight matches:** **yes — render `<b>...</b>` markers from FTS5's `snippet()` call as `tokens.accent`-colored bold spans.** The snippet is already escaped/safe by FTS5; we just style the markup.

These collapse the v1 scope and unblock Phase 0.

---

## 7. Stretch / v2 ideas (deferred)

- **Operator filters**: `from:assistant`, `before:2026-04-01`, `kind:tool_call`
- **Saved searches**: pin a query, see fresh results when new messages arrive
- **Cross-session timeline view**: scroll a single timeline of all messages across sessions, search-filtered
- **Embedding search**: vector index alongside FTS5 for semantic recall ("when did we discuss authentication?"). Requires a new dep + storage; significant scope.
- **Search inside attachments**: PDFs and images already produce derived text via `derived_artifacts`. Index those too.
- **Server-side recent queries** for cross-device sync (low priority for single-user)
- **Cmd+K as system shortcut** registered with iOS (UIKeyCommand). For iPad usability.

---

## 8. References

- [SQLite FTS5 docs](https://www.sqlite.org/fts5.html) — virtual tables, BM25, snippet(), tokenizers
- [better-sqlite3 docs](https://github.com/WiseLibs/better-sqlite3) — already in our stack
- [drizzle-orm SQLite migrations](https://orm.drizzle.team/docs/migrations) — for the schema additions
- [`@shopify/flash-list`](https://shopify.github.io/flash-list/) — already in project; use for results list
- Internal: `VOICE_INPUT_PLAN.md` — sibling plan doc, similar staging pattern
- Internal: `IOS_NATIVE_TOOLS_PLAN.md` — same
- Internal: `backend/src/db/schema.ts` — current `chatHistory` table definition
- Internal: `backend/src/ws/event-log.ts` — sweeper pattern for the indexer's "run-on-boot" lifecycle
- Internal: `frontend/app/(app)/(chats)/chat/[id].tsx` — chat screen to extend for deep-link

---

## 9. When to revisit

Re-read this doc before starting **Phase 0**. Specifically check:

- Has `chat_history` schema changed since 2026-05-05? (search columns must align with current text fields)
- Has FlashList changed APIs? (used in result list + scroll-to-index)
- Did the chat screen get refactored? (deep-link target moved)

If anything significant changed, run Phase 0 spike first to revalidate the JSON-extraction logic and the scroll-to-index target.
