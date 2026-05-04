# Search Across All Chats + Quick Switcher

**Status:** Design + plan. Not started. Captured 2026-05-05.

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

### Phase 0 — Spike + scope vetting (1-2 hours)

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
-- FTS5 virtual table mirroring searchable text from chat_history.
-- Schema: external content table to avoid duplicating storage.
-- session_id is denormalized for fast filtering by session.
CREATE VIRTUAL TABLE chat_history_fts USING fts5(
  session_id UNINDEXED,
  role UNINDEXED,
  text,
  content='chat_history',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

-- Triggers to keep FTS in sync. Triggered on every chat_history mutation.
-- We extract text from payload_json's structured shape (kind='message', etc.)
-- via app-level JSON parsing — see indexer.ts. The trigger here just calls
-- a per-row insert with rowid; the actual text comes from a populated column
-- that the app code keeps fresh.

-- (Alternative: add a generated column `search_text` to chat_history that's
--  populated by app code at insert time, and FTS indexes that.)

-- For simplicity in v1: add a search_text column to chat_history.
ALTER TABLE chat_history ADD COLUMN search_text TEXT;

-- Repopulate triggers:
CREATE TRIGGER chat_history_fts_ai AFTER INSERT ON chat_history BEGIN
  INSERT INTO chat_history_fts(rowid, session_id, role, text)
    VALUES (new.id, new.app_session_id, '', COALESCE(new.search_text, ''));
END;
CREATE TRIGGER chat_history_fts_ad AFTER DELETE ON chat_history BEGIN
  INSERT INTO chat_history_fts(chat_history_fts, rowid, session_id, role, text)
    VALUES('delete', old.id, old.app_session_id, '', COALESCE(old.search_text, ''));
END;
CREATE TRIGGER chat_history_fts_au AFTER UPDATE ON chat_history BEGIN
  INSERT INTO chat_history_fts(chat_history_fts, rowid, session_id, role, text)
    VALUES('delete', old.id, old.app_session_id, '', COALESCE(old.search_text, ''));
  INSERT INTO chat_history_fts(rowid, session_id, role, text)
    VALUES (new.id, new.app_session_id, '', COALESCE(new.search_text, ''));
END;
```

#### Schema update

`backend/src/db/schema.ts`:

Add `searchText: text("search_text")` to `chatHistory`.

#### Backfill indexer

`backend/src/db/indexer.ts` (new):

```ts
export async function backfillSearchIndex(db: Db, log: AppLogger): Promise<void> {
  // 1. Read all chat_history rows where search_text IS NULL.
  // 2. For each: parse payload_json, extract human-readable text per kind.
  // 3. UPDATE chat_history SET search_text = ... WHERE id = ?.
  //    Triggers populate FTS automatically.
  // 4. Log progress per 1k rows.
}
```

Run on every server boot (idempotent — only touches rows with `search_text IS NULL`).

#### Helper: extract text from payload

```ts
// chat_history kinds we care about (skip streaming-only kinds):
//   - "message" (role=user|assistant): payload.text
//   - "tool_call": payload.tool_name + JSON.stringify(payload.input)
//   - "tool_result": payload.text or stringified output
//   - "reasoning": payload.text (may be long; truncate to 4KB)
function extractSearchableText(kind: string, payload: unknown): string | null { ... }
```

Truncate per-row to 16KB to keep FTS table compact.

Acceptance: deploy, indexer runs at boot, log shows "indexed N rows" once. Verify with `SELECT count(*) FROM chat_history_fts`.

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
  snippet(chat_history_fts, 2, '<b>', '</b>', '…', 12) AS snippet
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

## 6. Open questions for the user (resolve before Phase 0)

- **Q1**: Trigger for the switcher. Pick one or all:
  - **Long-press the active tab** (subtle, no extra UI)
  - **Swipe-down on the chat list** (discoverable from the chats tab)
  - **Dedicated icon in the chats tab navbar** (most discoverable, takes a slot)
  - **All three** (more work, more flexible)
  - Plus optional: **Cmd+K on iPad** (defer if RN 0.83 makes it painful)

  *My recommendation: long-press tab + dedicated icon, defer swipe-down to v2*

- **Q2**: Scope v1.
  - **Sessions only** (search inside chat content, results are messages)
  - **Sessions + skills** (also fuzzy-match skill names — useful for "run weekly review skill")
  - **Sessions + skills + cron** (also cron job names)
  - **Sessions + skills + cron + inbox notifications**

  *My recommendation: Sessions only for v1. Sessions + skills/cron in v2 — they're each 1-hour add-ons.*

- **Q3**: Search history.
  - **Persist last 10 queries** (recall + tap to re-run)
  - **Don't persist** (privacy — searches don't leak across app launches)

  *My recommendation: persist 10. AsyncStorage on device, no backend storage. User can clear from settings.*

- **Q4**: Highlight match in results.
  - **Yes** — render `<b>match</b>` from snippet as bold (with `tokens.accent` color)
  - **No** — plain snippet, position-aware ranking is enough

  *My recommendation: yes. The snippet is already from FTS5's `snippet()` call which is safe; just style the bolds.*

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
