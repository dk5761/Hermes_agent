# Todo Panel — implementation plan

Surface Hermes' agent-managed todo list as an inline card in the chat stream. Agent owns mutations (mark done / reorder / cancel / edit). User can read the plan, add a step, pin/collapse the card.

Visual target: design provided in conversation (dark card with title + progress + steps + "+ Add step" / "☆ Pin" footer).

---

## Architecture overview

### Data flow (existing — zero backend changes)

```
Hermes agent
   │
   │ calls todo tool — TodoStore.write(items)
   ▼
tool result returned
   │
   ▼
tui_gateway/server.py::_on_tool_complete
   │ extracts result.todos array
   ▼
WebSocket emits:
   tool.complete { tool_id, name: "todo", todos: TodoItem[], duration_s, summary }
   │
   ▼
Gateway gateway-ws.ts
   │ persists to ws_events (replay log) AND chat_history (kind: "tool.call")
   ▼
Frontend
   │ chat-store reducer: case "tool.complete" already handled (renders generic tool card)
   ▼
Message component renders <ToolCallCard />
```

### What changes

When `tool.call` row has `payload.name === "todo"`, render a specialized **`<TodoPlanCard />`** instead of the generic ToolCallCard. The card pulls `payload.todos: TodoItem[]` directly from the existing payload — no new persistence, no schema change.

```ts
// Already in chat-store types
interface ToolCallCard {
  kind: "tool";
  id: string;             // tool_call_id from upstream
  name: string;           // "todo" when this is a plan
  status: "running" | "complete" | "error";
  detail: Record<string, unknown>;  // includes `todos` when name === "todo"
  createdAt: string;
}

interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}
```

### Scope boundary — agent vs user

| Action | Owner | Mechanism |
|---|---|---|
| Mark step done | Agent | tool call after natural-language prompt, OR autonomous |
| Reorder steps | Agent | natural-language prompt, agent re-invokes `todo` |
| Cancel step | Agent | natural-language prompt |
| Edit step content | Agent | natural-language prompt |
| Replan from scratch | Agent | natural-language prompt |
| **Add step** | **User** | tap `[+ Add step]` → user message → agent appends |
| **Pin / unpin** | **User** | local state, never sent to agent |
| **Collapse / expand** | **User** | local state, never sent to agent |

Read-only checkbox / long-press / tap-to-cycle UX is **not** built. Users prompt the agent to mutate.

---

## Stage 0 — Pre-flight (~15 min, read-only investigation)

Goal: confirm the Hermes todo data flow is alive before building UI.

### Tasks

1. **Trigger a `todo` tool call** in a real chat. Send a message like "Plan the next 4 steps to add voice support, then start on step 1." Agent should call `todo` to set up the plan.

2. **Inspect the WS frame** in gateway logs:
   ```bash
   docker compose logs -f gateway | grep '"name":"todo"'
   ```
   Confirm `tool.complete` events arrive with `payload.todos: [...]` containing real items.

3. **Inspect chat_history persistence**:
   ```bash
   docker compose exec gateway sqlite3 /app/data/gateway.db \
     "SELECT id, kind, substr(payload_json, 1, 200) FROM chat_history WHERE payload_json LIKE '%\"name\":\"todo\"%' ORDER BY id DESC LIMIT 3"
   ```
   Confirm each row has the full todos array.

4. **Note the tool_id** — the unique identifier we'll use for "is this the latest todo card?" tracking.

### Acceptance

- At least one chat_history row exists with `kind="tool.call"`, `payload.name==="todo"`, `payload.todos: TodoItem[]`.
- WS replay log contains corresponding `tool.complete` events.

If none of the above produces data, the bug is upstream of UI work. Don't proceed to Stage 1 until you see the data.

---

## Stage 1 — Read-only TodoPlanCard (~2 hours)

Goal: when the agent's plan exists in chat history or arrives via WS, render the specialized card visual. No interactivity.

### 1.1 Files to create

#### `src/components/ui/TodoPlanCard.tsx` (~180 lines)

Top-level component for the entire card. Props:

```ts
interface TodoPlanCardProps {
  toolCallId: string;          // for `latestTodoToolId` matching
  sessionId: string;
  todos: TodoItem[];
  status: "running" | "complete" | "error";
  isLatest: boolean;           // controls active state visuals
  createdAt: string;
}
```

Layout:

```
┌─────────────────────────────────────────┐
│ [📋]  <derived title>                    │
│       <progress>/<total> done · <hint>   │
│                              [⟳]    [⌄]  │   ← spinner if running, chevron toggles collapse
├─────────────────────────────────────────┤
│ [TodoStepRow]                            │   ← repeated per item
│ ...                                      │
├─────────────────────────────────────────┤
│ [+ Add step]                  [☆ Pin]    │   ← only on isLatest === true
└─────────────────────────────────────────┘
```

Styling:
- Outer: `bg-surface border border-line rounded-[14px] mx-1.5 my-1` (matches generic tool card)
- Header: padding 12, gap 8, accent icon tile 28x28 rounded-md `bg-accent-bg`
- Divider: 1px `border-line-soft` between sections
- Footer: padding 10, hidden when not latest

Helpers:

```ts
function deriveTitle(todos: TodoItem[]): string;
//  joins first 2-3 contents with " → " arrow, max ~36 chars

function deriveProgress(todos: TodoItem[]): { done: number; total: number; activeContent: string };
//  done = completed count
//  activeContent = first in_progress, or first pending, or "" if all done

function isRunning(todos: TodoItem[]): boolean;
//  true if any item is in_progress
```

#### `src/components/ui/TodoStepRow.tsx` (~50 lines)

Single step row.

```ts
interface TodoStepRowProps {
  item: TodoItem;
  isFirst?: boolean;
}
```

Renders:
- Status circle 18x18 + content text
- "now" pill (text-micro accent bg) on the in-progress item, right-aligned
- Strikethrough + ink-3 color for completed/cancelled
- Padding 10x14, no border (parent handles dividers)

Status icon mapping:

| Status | Visual |
|---|---|
| `pending` | empty circle, 1.5px border `ink-3` |
| `in_progress` | bullseye — outer ring `accent`, inner filled circle `accent` |
| `completed` | filled circle `positive` with white check |
| `cancelled` | filled circle `ink-3` with white × |

Use `<Icon>` for check / × glyphs, `<View>` for the circles via inline styling.

### 1.2 Files to modify

#### `src/state/chat-store.ts`

Add to `ChatStoreState`:

```ts
// Per-session: the most recent tool_call_id where name === "todo".
// Used by TodoPlanCard to decide whether it's "active" (allows interactivity).
latestTodoToolIdById: Record<string, string | null>;
```

Reducer update in `applyEnvelope`:

```ts
case "tool.complete": {
  // existing handling — moves running tool to messages
  // ADD:
  if (env.payload?.name === "todo") {
    next.latestTodoToolIdById[appSessionId] = env.payload.tool_id;
  }
  break;
}
```

Selector:

```ts
export function useIsLatestTodoCard(sessionId: string, toolCallId: string): boolean {
  return useChatStore((s) => s.latestTodoToolIdById[sessionId] === toolCallId);
}
```

Also need to track `latestTodoToolIdById` from cold-load history. In `chat/[id].tsx::historyRows` (or a separate `useEffect`), walk rows once when messagesQuery fires and find the highest-id `tool.call` with `payload.name === "todo"`. Call a new `setLatestTodoToolId(sessionId, toolCallId)` action.

#### `src/components/ui/Message.tsx`

Inside the `tool` case of the message renderer:

```ts
if (message.kind === "tool") {
  const todos = message.detail?.todos as TodoItem[] | undefined;
  const isTodo = message.name === "todo" && Array.isArray(todos);
  if (isTodo) {
    return (
      <TodoPlanCard
        toolCallId={message.id}
        sessionId={sessionId}
        todos={todos}
        status={message.status}
        isLatest={useIsLatestTodoCard(sessionId, message.id)}
        createdAt={message.createdAt}
      />
    );
  }
  return <ToolCallCard ... />;  // existing fallback
}
```

#### `src/components/ui/index.ts`

Barrel export `TodoPlanCard`, `TodoStepRow`.

### 1.3 Acceptance

- Send a chat that triggers the agent to call `todo`. Card appears in the message stream with title, progress, all steps in correct visual states.
- Strikethrough applies to completed/cancelled.
- "now" pill on in_progress.
- Spinner animates while any item is in_progress, stops when all settled.
- Cold-load (close + reopen chat): card re-renders with the same content from history.
- Multiple plan cards: each renders correctly, only the latest has the footer (which is empty until Stage 2).
- `pnpm typecheck` clean.

---

## Stage 2 — Add step + Pin + Collapse (~1.5 hours)

Goal: bring the card to feature-parity with the screenshot. User can append steps, pin the latest plan to the top, and collapse the card.

### 2.1 Files to create

#### `src/components/ui/AddStepSheet.tsx` (~70 lines)

Modal sheet via `@gorhom/bottom-sheet` (already in Stage 2 components). Single text input + Cancel/Add buttons.

```ts
interface AddStepSheetProps {
  visible: boolean;
  onCancel: () => void;
  onSubmit: (content: string) => void;
}
```

Validation: content non-empty + length cap 200.

On Add: close sheet, call `onSubmit(content)`.

#### `src/state/todos.ts` (~30 lines)

Zustand store keyed per-card for pin + collapse state. Persisted to AsyncStorage so state survives reload.

```ts
interface TodosUiState {
  pinnedByCard: Record<string, boolean>;       // keyed by `${sessionId}:${toolCallId}`
  collapsedByCard: Record<string, boolean>;
  togglePinned: (key: string) => void;
  toggleCollapsed: (key: string) => void;
  hydrate: () => Promise<void>;
}
```

AsyncStorage keys:
- `todos.pinned.v1` → JSON `Record<string, true>`
- `todos.collapsed.v1` → JSON `Record<string, true>`

Hydrate on root layout mount alongside auth/theme stores.

### 2.2 Files to modify

#### `src/components/ui/TodoPlanCard.tsx`

Wire footer buttons (only rendered when `isLatest`):

```ts
const cardKey = `${sessionId}:${toolCallId}`;
const pinned = useTodosUi((s) => !!s.pinnedByCard[cardKey]);
const collapsed = useTodosUi((s) => !!s.collapsedByCard[cardKey]);
const togglePin = useTodosUi((s) => s.togglePinned);
const toggleCollapsed = useTodosUi((s) => s.toggleCollapsed);

const [addOpen, setAddOpen] = useState(false);

// Header chevron toggles `collapsed`
// Footer "+ Add step" → setAddOpen(true)
// Footer "☆ Pin" → togglePin(cardKey)
```

Pin star icon visual:
- Default: outline star (`ink-3`)
- Pinned: filled star (`accent`)

Collapsed visual:
- Hide all step rows + footer
- Header subtitle changes to a 1-liner: `${doneCount}/${total} done · ${activeContent}`
- Chevron rotates 0deg (collapsed) → 180deg (expanded) via Reanimated `withTiming`

#### `app/(app)/(chats)/chat/[id].tsx`

Add `onAddStep` handler that the chat screen passes down to the latest TodoPlanCard via a prop or context:

```ts
const onAddStep = useCallback(
  (content: string) => {
    if (!sessionId) return;
    const text = `Add this step to the plan: "${content}"`;
    sendChat(text);  // existing send pipeline
  },
  [sessionId, sendChat],
);
```

How does the card reach the handler? Two options:
- Prop drilling via `<Message>` (clean but invasive)
- Module-level imperative function set once per chat screen via useEffect (faster to ship)

Pick prop drilling: add `onAddStep?: (content: string) => void` to `MessageProps`, conditionally pass when rendering tool card with name="todo".

**Sticky pinned card** rendering:

Find the latest pinned card across the session's messages — there's at most one pinned card per session (toggling pin on a new card unpins the old). Track via `pinnedByCard` keys filtered by `${sessionId}:`.

Render that card as a sticky element ABOVE the inverted FlatList:

```tsx
{pinnedCard ? (
  <View style={{ /* shadow, z-index */ }}>
    <TodoPlanCard {...pinnedCard.props} />
  </View>
) : null}
<FlatList inverted ... />
```

Implementation detail: the same card is ALSO rendered in its original timeline position. To avoid visual duplication, when pinned, replace the timeline card with a thin "Plan pinned to top" placeholder row (or hide it; both work).

#### `app/_layout.tsx`

Hydrate `useTodosUi` alongside `useAuthStore` on mount.

### 2.3 Acceptance

- Tap `[+ Add step]` → sheet opens with input
- Type content + Add → sheet closes → user message sent → agent processes → card updates with new pending item
- Tap `[☆ Pin]` → star fills accent → card sticks to top of chat list as you scroll messages
- Pin a different plan card → previous one unpins automatically (only one pinned per session)
- Tap header chevron → card collapses to 1-line summary; tap again → expands
- Pin/collapse state survives app reload (verified via AsyncStorage)
- `pnpm typecheck` clean
- All 6 themes render the card correctly (paper-light, paper-dark, graphite-light, graphite-dark, plot-light, plot-dark)

---

## Files manifest

```
NEW
  src/components/ui/TodoPlanCard.tsx        ~200 lines
  src/components/ui/TodoStepRow.tsx          ~50 lines
  src/components/ui/AddStepSheet.tsx         ~70 lines
  src/state/todos.ts                          ~80 lines

MODIFY
  src/state/chat-store.ts
    + latestTodoToolIdById field
    + setLatestTodoToolId action
    + reducer update on tool.complete (name="todo")

  src/components/ui/Message.tsx
    + special case for tool.call with name="todo" → TodoPlanCard

  src/components/ui/index.ts
    + barrel exports

  app/(app)/(chats)/chat/[id].tsx
    + onAddStep handler
    + cold-load setLatestTodoToolId from history
    + sticky pinned card render above FlatList

  app/_layout.tsx
    + hydrate useTodosUi alongside other stores
```

Backend: zero changes.

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Agent doesn't call `todo` for short tasks → card never appears | Expected. Card is hidden when no todos. Not a bug. |
| Agent uses different tool names (e.g. `plan`, `tasks`) | We hard-match `name === "todo"`. If Hermes upstream renames, change one constant. |
| `payload.todos` shape drifts upstream | Defensively parse with type guard; on failure fall back to generic ToolCallCard. |
| User prompts "remove all todos" but agent doesn't act | Out of our control; user can re-prompt with clearer language. |
| Add-step turn cost noise | 1 LLM turn per add; user accepts since they explicitly tapped a button. |
| Pinned card causes weird scroll behavior | Render sticky card with fixed height; FlatList scrolls underneath. Standard pattern. |

---

## Time estimate

| Stage | Effort |
|---|---|
| 0 (pre-flight) | 15 min |
| 1 (read-only card) | 2 hr |
| 2 (Add step + Pin + Collapse) | 1.5 hr |
| **Total** | **~3.5 hr** |

Single subagent run for Stages 1 + 2 combined is reasonable; or split into two if budget is tight. Stage 0 is manual verification you do before kicking the agent.

---

## What's deliberately NOT in scope

- Tap-to-cycle status on individual rows
- Long-press action sheet on rows
- Drag-reorder
- Edit step content modal
- Bulk "clear completed" sweep button
- Slash command path (`tui_gateway/server.py` upstream patch)
- Multiple pinned cards per session (max 1)
- Cross-session pinning (each chat has its own)
- Animated step transitions (status flips render instantly)
- Plan summary in the session list row

If any of these become important later, they're additive and don't conflict with Stages 0–2.
