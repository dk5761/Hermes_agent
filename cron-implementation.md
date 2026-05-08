# Hermes — Cron module implementation spec

This doc describes the cron module of the Hermes mobile app in enough detail for Claude Code (or any engineer) to implement it in **React Native + NativeWind**. It covers the screens, navigation graph, data shape, component anatomy, and behaviors.

The visual reference lives in `design/screens-2.jsx` (HTML/JSX prototype). This doc is the source of truth — the prototype may have minor visual liberties.

---

## 1. Scope

The cron module lets users:

- See all scheduled "cron" jobs (an LLM task on a recurring schedule).
- See outputs (run results) of those jobs, grouped by job.
- Read a single output in full.
- Create, edit, pause, resume, run-now, and delete jobs.

The cron tab in the bottom tab bar opens the **Cron list** screen, which is split into two top-level tabs: **Jobs** and **Outputs**.

---

## 2. Navigation graph

All routes sit under the `Cron` tab.

| Route key            | Screen                | Drilled in from                                        |
|----------------------|-----------------------|--------------------------------------------------------|
| `cron`               | `CronList`            | Tab bar                                                |
| `cronJob`            | `CronDetail`          | `cron` (Jobs tab → row tap)                            |
| `cronJobOutputs`     | `CronJobOutputs`      | `cron` (Outputs tab → row tap)                         |
| `cronOut`            | `CronOutput`          | `cronJob` (Recent runs row) and `cronJobOutputs` (any row) |
| `cronEdit`           | `CronEditor`          | `cron` (`+` button) and `cronJob` (edit nav icon)      |

Navigation params:

- `cronJob` and `cronJobOutputs` receive `{ job: Job }`.
- `cronOut` receives `{ output: Output, job: Job }`.
- `cronEdit` receives `{ jobId?: string }` — omit for "new".

Every screen has an iOS-style back button in its NavBar. `CronEditor` uses **Cancel** (left) and **Save** (right) text buttons instead of a back chevron.

---

## 3. Data model

```ts
type CronJob = {
  id: string;
  name: string;                       // user-facing
  schedule: string;                   // raw cron expression, e.g. "0 9 * * 1-5"
  scheduleDisplay: string;            // human, e.g. "Weekdays · 9:00"
  last: string;                       // human relative, e.g. "14h ago", "4m ago"
  state: 'enabled' | 'paused';
  notify: boolean;                    // push on completion
  deliver: 'telegram' | 'origin' | 'local' | string;
  next?: string;                      // human, e.g. "tomorrow · 9:00", "in 26m"
  running?: boolean;                  // currently mid-run
  prompt: string;                     // the LLM task body
  model?: string;                     // e.g. "auto · gpt-5"
  toolsetCount?: number;              // e.g. 3
  repeat?: 'forever' | string;
  workdir?: string;                   // e.g. "~/work/digest"
};

type CronOutput = {
  id: string;
  jobId: string;
  ts: string;                         // human, "Today · 09:00", "Apr 24 · 09:00"
  preview: string;                    // ~1–2 sentence summary
  body: CronOutputBody;               // full content for the reader
};

type CronOutputBody = {
  title: string;                      // e.g. "Standup digest — May 1"
  blockers?: string[];                // bullet items (markdown lines OK)
  updates?: string[];
  deploys?: string;                   // monospace block
};
```

Backend is expected to return outputs sorted **newest first**. UI code should not re-sort.

---

## 4. Screens

### 4.1 `CronList` — the cron tab root

**NavBar (large title)**

- Title: `Cron`
- Subtitle: depends on tab
  - Jobs tab: `${jobs.length} jobs · ${runningCount} running`
  - Outputs tab: `${totalRecentRuns} recent runs · ${jobs.length} jobs`
- Trailing: `+` icon (only on Jobs tab) → push `cronEdit` (new)

**Tabs**

A `SegControl` directly below the NavBar:

```
[ Jobs    Outputs ]
```

- Two segments only.
- Persist the active tab in component state for the session — does not need to survive reload.
- Switching tabs **does not** reset the Jobs filter chips.

#### 4.1.1 Jobs tab body

A horizontal scroll row of filter chips, then a vertical list of jobs.

**Filter chips** (single-select, default `All`)

- `All`
- `Enabled · ${enabledCount}`
- `Paused · ${pausedCount}`
- `Notify on` — filters to `notify === true` (visual only for now; not required)
- `Sort: name` — opens a sort sheet (visual only for now; not required)

**Job row** — full-width tappable, 14×16 padding, 1px hairline divider between rows.

```
[ icon ]   Job name                                  [bell] last
           0 9 * * 1-5  ·  Weekdays · 9:00
           [status pill]
```

- **Icon block**: 36×36, `rounded-2xl` (10px radius). When `running`, background uses `theme.accentBg` with a `theme.accent + "55"` 1px border and clock icon in `theme.accent`. Otherwise background is `theme.chip` with icon in `theme.ink2`.
- **Name**: `bodyLg` (15px), weight 500, single-line ellipsis.
- **Right column**: small bell icon (visible only when `notify`) + relative `last` in mono micro caption color `theme.ink3`.
- **Schedule line**: cron expression in mono + `·` + human schedule, all in `theme.ink3` caption.
- **Status pill** (one of):
  - `running · {Ns}` → `connecting` variant (amber/animated)
  - `paused` → `paused` variant (gray)
  - `next {job.next || 'soon'}` → `online` variant (accent/green)

Tap row → push `cronJob`.

#### 4.1.2 Outputs tab body

A vertical list. **One row per job that has outputs** (sorted by `latest.ts`, newest first).

```
[ terminal icon ]  Job name                               Today
                   2-line preview of the latest output…
                   12 runs · Weekdays · 9:00                     >
```

- **Icon block**: 36×36, `theme.chip` background, `terminal` icon, color `theme.ink2`.
- **Job name**: `bodyLg`, weight 500, single-line ellipsis.
- **Right of name**: short timestamp (the day fragment of `latest.ts`, e.g. `Today`, `Yesterday`, `Mon`, `Apr 24`).
- **Preview**: `body` (14px), color `theme.ink2`, **clamped to 2 lines** via `WebkitLineClamp` / `numberOfLines={2}`.
- **Footer line**: `${outputs.length} runs · ${job.scheduleDisplay}`, all caption / `theme.ink3`.
- **Trailing**: chevron-right at row's vertical center.

Tap row → push `cronJobOutputs` with the job.

If a job has zero outputs, **omit it** from this tab. If no jobs have any outputs, render an `EmptyState` with copy `No runs yet — your jobs will appear here once they execute.`

---

### 4.2 `CronDetail` — single-job summary

NavBar: title is `job.name` (single line, ellipsis), trailing nav icon `edit` → `cronEdit` with `{ jobId: job.id }`.

Sections (in order):

1. **Hero card** (margin 16, rounded 14, surface bg, 1px line)
   - Top row, space-between:
     - Left stack: micro/uppercase `SCHEDULE` label, `h2` `job.scheduleDisplay`, mono caption `job.schedule`.
     - Right: status pill — `paused` if paused, else `enabled`.
   - Hairline divider.
   - 4 key/value rows (caption text):
     - `Next run` → `job.next` (mono right)
     - `Last run` → `job.last` (mono)
     - `Model` → `job.model` (mono)
     - `Deliver to` → `job.deliver` (mono)

2. **Action row** (margin 16, two equal-width buttons)
   - `Pause` ⇄ `Resume` (secondary, with `pause`/`play` left icon).
   - `Run now` (primary, `bolt` left icon).

3. **Prompt** section (`Section title="Prompt"`)
   - `MonoBlock` containing `job.prompt`.

4. **Notify** list group (single row)
   - Bell icon, title `Notify on completion`, subtitle `Push to all signed-in devices`, trailing `Toggle` bound to local `notify` state.

5. **Recent runs** section (`Section title="Recent runs"` with `See all` accent text)
   - Up to **4** most recent outputs for this job, in a single rounded surface card with hairline dividers between rows.
   - Each row: mono caption `ts` (left), chevron right (right), then a 1-line ellipsised `preview` below.
   - Tap row → push `cronOut` with `{ output, job }`.

6. **Danger** list group
   - Single row: `trash` icon, title `Delete job`, `danger` styling. Tap shows a destructive action sheet (`Delete`/`Cancel`).

---

### 4.3 `CronJobOutputs` — every output of one job

NavBar: title `Outputs`, back chevron.

**Header card** (above the list, padding 16)

- Micro/uppercase label `FROM JOB`.
- Row: 28×28 chip-bg square with `clock` icon, then stacked:
  - `bodyLg` weight 500: `job.name`.
  - mono caption: `${job.scheduleDisplay} · ${outputs.length} runs`.

**List**

Vertical list, **all** outputs of this job, newest first, no grouping.

Row layout (14×16 padding, hairline divider between rows):

```
ts (mono caption)                                          >
2-line preview
```

- `ts` left, chevron right on the same line.
- Preview below, body, 2-line clamp.

Tap row → push `cronOut` with `{ output, job }`.

If outputs is empty, show `EmptyState` `No runs yet`.

---

### 4.4 `CronOutput` — read a single run

NavBar: title is `output.ts` (e.g. `Today · 09:00`). Trailing icons: `copy` and `share`.

Body (scrollable):

1. **From-job badge** — small surface card:
   - Micro/uppercase `FROM JOB`.
   - Row with `clock` icon + `job.name` caption.
2. **Title** — `h2`, `output.body.title`.
3. **Sections** rendered in order if present:
   - **Blockers** — micro uppercase label in `theme.warning`, then each blocker as a `body` paragraph.
   - **Updates** — micro uppercase label in `theme.ink3`, paragraphs.
   - **Deploys · last 24h** — micro uppercase label in `theme.ink3`, then a `MonoBlock`.

For now, render `body` as semi-structured (above). When real runs come from the gateway, swap for a markdown renderer. Match the same vertical rhythm: 14px gap between sections, 4px gap inside a section.

---

### 4.5 `CronEditor` — create / edit

NavBar: title `New cron job` or `Edit job`. Leading **Cancel** text button (accent), trailing **Save** text button (accent, weight 600).

Body sections:

1. **Identity / prompt** (margin 16)
   - `Field` `Name` → text input.
   - `Field` `Prompt` (hint `What should Hermes do on each run?`) → 5-row textarea, no resize, surface bg.

2. **Schedule** section
   - Row of preset chips (single-select):
     - `Every hour` → `0 * * * *`
     - `Daily · 9am` → `0 9 * * *`
     - `Weekdays · 9am` → `0 9 * * 1-5`
     - `Fridays · 6pm` → `0 18 * * 5`
   - `Field` `Cron expression` → mono text input. Editing decouples from preset (clears active chip).
   - **Preview card** (surface bg, 12 padding, rounded 10): micro/uppercase `NEXT 3 RUNS`, then 3 mono captions of the next 3 fire times. Compute via a cron parser (e.g. `cron-parser`) using the device tz; show `(UTC{±N})` only on the first row.

3. **Run config** list group (`header="Run config"`)
   - `Model` → `auto · gpt-5` (chevron, opens model picker)
   - `Toolsets` → `${n} enabled` (chevron)
   - `Deliver to` → `origin` (chevron, sheet w/ telegram/origin/local/…)
   - `Repeat` → `forever` (chevron)
   - `Workdir` → `~/work/digest` (chevron)

4. **Notify** list group — single row with toggle, default ON.

Validation: `Save` is disabled if `name` or `prompt` is empty, or if `schedule` is not a valid cron.

---

## 5. Reusable components

All from the existing UI kit (see `design/ui.jsx` and `theme.ts`):

- `NavBar` (with `large` mode for `CronList`)
- `SegControl` — used for the Jobs/Outputs tabs
- `Chip` — filter row + cron presets
- `Section` — titled section with optional right-aligned action
- `ListGroup` / `ListRow` — config and notify rows
- `StatusPill` — `online`, `connecting`, `paused`
- `Icon` — `clock`, `terminal`, `bell`, `bolt`, `pause`, `play`, `edit`, `plus`, `share`, `copy`, `trash`, `chevR`
- `MonoBlock` — prompt + deploys
- `Toggle`, `Button`, `Input`, `Field`
- `Text` (kinds: `h2`, `bodyLg`, `body`, `caption`, `micro`)

Any cron screen that needs new visuals (e.g. the Outputs tab row) should be built from these primitives, not new ones.

---

## 6. Behaviors

- **Tab switching** in `CronList` is local state. Default `jobs`. The trailing `+` button is hidden on the Outputs tab.
- **Pause/Resume** in `CronDetail` flips local state immediately and fires the gateway request optimistically.
- **Run now** triggers an immediate run; the row's status pill should switch to `running · 0s` and the timer increments per second from the gateway's pushed updates.
- **Delete job** confirms via destructive action sheet, then pops to `cron`.
- **CronJobOutputs**: if a new run completes while the screen is open, prepend to the list with a 200ms accent flash on the first row.
- **CronOutput** copy and share use the platform share sheet with `output.body.title` + a markdown rendering of the body.

---

## 7. Empty / loading states

- `CronList` Jobs tab, no jobs: `EmptyState` `No cron jobs yet` + primary `Create one` button → `cronEdit`.
- `CronList` Outputs tab, no outputs anywhere: `No runs yet — your jobs will appear here once they execute.`
- `CronJobOutputs`, no outputs: `No runs yet`.
- Loading: a 3-row skeleton list (rounded grey blocks at job-row dimensions).
- Error: inline banner above the list, `Couldn't load. Retry`.

---

## 8. File layout suggestion (RN)

```
src/screens/cron/
  CronListScreen.tsx         // tabs + Jobs body
  CronOutputsByJob.tsx       // Outputs tab body
  CronDetailScreen.tsx
  CronJobOutputsScreen.tsx
  CronOutputScreen.tsx
  CronEditorScreen.tsx
  components/
    JobRow.tsx
    OutputsByJobRow.tsx
    OutputRow.tsx
    HeroCard.tsx
    SchedulePresets.tsx
    NextRunsPreview.tsx
src/state/cron/
  api.ts                     // gateway client
  hooks.ts                   // useJobs, useJobOutputs(jobId), useOutput(id)
  types.ts                   // the types in §3
```

`useJobs` and `useJobOutputs` should be `react-query` hooks with a 30s `staleTime` and websocket invalidation on `job.run.completed` events.

---

## 9. Acceptance checklist

- [ ] Cron tab opens to **Jobs** by default.
- [ ] Switching to **Outputs** changes subtitle to `N recent runs · M jobs` and hides the `+`.
- [ ] Tapping a job in Jobs pushes `CronDetail`; tapping a job in Outputs pushes `CronJobOutputs`.
- [ ] `CronJobOutputs` shows every output of the job, newest first, header card with job name + schedule + run count.
- [ ] Tapping any output (in Detail's Recent runs, or in Job outputs) pushes `CronOutput`.
- [ ] `CronEditor` Save is disabled until name + prompt + valid cron are present.
- [ ] All status pills, chips, mono text, and icons match the tokens in `theme.ts`.
- [ ] All list dividers are 1px hairlines in `theme.lineSoft`, never on the last row.
- [ ] All screens scroll inside the safe area; bottom padding 60 to clear the tab bar.
