# Cron Tabs — Implementation Plan

Goal: add **Jobs / Outputs** tabs to the Cron module. Outputs become a top-level browsable inbox, separated from individual jobs.

Source of truth: `cron-implementation.md` (UX spec).

---

## 0. Current state (what exists)

### Backend (TS Fastify proxy → Python hermes-agent)
- `GET /cron/jobs` — augmented with `notifyOnComplete`. ✅
- `GET /cron/jobs/:id` — same. ✅
- `POST /cron/jobs`, `PATCH /cron/jobs/:id`, `DELETE /cron/jobs/:id`. ✅
- `POST /cron/jobs/:id/{pause|resume|trigger}`. ✅
- `GET /cron/outputs?job_id=X` — FS scan of `~/.hermes/cron/output/{jobId}/`. ✅
- `GET /cron/outputs/:output_id?job_id=X` — single output md. ✅
- `cron-fs.ts` already lists & reads outputs from disk.

### Mobile
- `app/(app)/(cron)/index.tsx` — single Jobs list (444 lines). No tabs.
- `app/(app)/(cron)/[jobId]/index.tsx` — CronDetail (533 lines, has nested "Recent runs").
- `app/(app)/(cron)/[jobId]/output/[outputId].tsx` — CronOutput reader. ✅
- `app/(app)/(cron)/[jobId]/edit.tsx`, `app/(app)/(cron)/new.tsx`. ✅
- `src/api/cron.ts` — has `listOutputs(jobId)`, `getOutput(jobId, outputId)`. Missing cross-job aggregation.
- `src/api/types.ts` — `CronOutputSummary { id, jobId, createdAt, preview? }`. **Note: backend currently does NOT return `preview`.** UI computes from content or shows blank.

### Backend gap for new design
- Outputs tab needs **flat list across all jobs** ("one row per job that has outputs, sorted by latest"). Current API only does per-job listing → would require N+1 calls from mobile (one `listOutputs` per job).
- Need preview text in summary (currently absent).

---

## 1. Phase plan

Phases are sequential. Each phase ends with a green build + commit.

### Phase 1 — Backend: cross-job outputs aggregator + previews

**File: `backend/src/hermes/cron-fs.ts`**
- Add `listAllJobsOutputSummary(home: string): Promise<JobOutputSummary[]>` that:
  1. Reads `~/.hermes/cron/output/` directory entries (each entry = jobId).
  2. For each jobId dir, reads files → returns `{ jobId, latest: { id, createdAt, preview }, count }` with `latest` = newest by mtime.
  3. Skips empty dirs.
  4. Sorts by `latest.createdAt` desc.
- Add `extractPreview(content: string): string` — strip markdown headings/frontmatter, take first 1–2 non-empty lines, max ~160 chars.
- Update `listCronOutputs` to include `preview` per row (slice file content header — accept the small read cost; n≤200 files per job realistically).

**File: `backend/src/routes/cron.ts`**
- Add `GET /cron/outputs/by-job` → returns `{ items: JobOutputSummary[] }`.
  - No `job_id` query.
  - Auth same as others.
  - Returns the aggregated shape directly (no augmentation needed since job names come from `/cron/jobs` separately on the client; UI joins by id).

**Optional (defer if time-tight):** `GET /cron/outputs/recent?limit=N` for a flat newest-first feed across jobs. Spec doesn't require it (Outputs tab groups by job).

**Edge case — deleted jobs:**
- If a job dir exists but the job is not in `/cron/jobs` (job was deleted but FS dir survives), the aggregator still returns the row. Frontend renders with name `"(deleted job)"` and an `archived` badge.
- Decision required from user before coding: **keep or purge?** If purge, add a sweep on job DELETE. (Current backend leaves the dir; safer default = keep + badge.)

**Tests (Phase 1):**
- Unit: `cron-fs.test.ts` covering empty home dir, mixed empty / populated job dirs, sort order, preview extraction.
- Integration: hit the new route on a fixture home, assert shape.

**Deliverables:**
- New endpoint live, typed, tested.
- No mobile changes.

---

### Phase 2 — Mobile API client + types

**File: `frontend/src/api/types.ts`**
- Add:
  ```ts
  export interface JobOutputSummary {
    jobId: string;
    latest: {
      id: string;
      createdAt: number;          // ms epoch (normalize from ISO at boundary)
      preview: string;
    };
    count: number;
  }
  export interface JobOutputSummaryResponse { items: JobOutputSummary[]; }
  ```
- Extend `CronOutputSummary` to include `preview?: string` (already optional, just confirm boundary populates).

**File: `frontend/src/api/cron.ts`**
- Add `listOutputsByJob(): Promise<JobOutputSummaryResponse>` calling `/cron/outputs/by-job`.
- Update `cronKeys`:
  ```ts
  outputsByJob: () => ["cron", "outputs", "by-job"] as const,
  ```
- Type-guard the response shape (mirroring existing pattern at file top).

**Deliverables:**
- API surface ready, no UI yet. Type-checks pass.

---

### Phase 3 — Mobile UI: SegControl + Jobs tab refactor

**File: `frontend/app/(app)/(cron)/index.tsx`**
- Wrap existing Jobs body in a `SegControl` ([Jobs, Outputs]). State held locally (`useState<"jobs" | "outputs">("jobs")`).
- NavBar subtitle:
  - Jobs: `${jobs.length} jobs · ${runningCount} running` (already exists).
  - Outputs: `${totalRecentRuns} recent runs · ${jobs.length} jobs`.
- Trailing `+`: hide when tab === "outputs".
- Filter chips visible only on Jobs tab.
- Existing JobRow rendering survives unchanged.

**Files to extract (refactor for readability):**
- `frontend/src/components/cron/JobRow.tsx` (lift from index.tsx).
- `frontend/src/components/cron/OutputsByJobRow.tsx` (new, used in Phase 4).

This phase ends with: switching to Outputs tab shows an empty state placeholder (real list in Phase 4). Jobs tab functionally unchanged.

---

### Phase 4 — Mobile UI: Outputs tab body + CronJobOutputs screen

**Outputs tab body (inside `(cron)/index.tsx`):**
- `useQuery({ queryKey: cronKeys.outputsByJob(), queryFn: listOutputsByJob, staleTime: 30_000 })`.
- Join with `useQuery(cronKeys.jobs())` to look up `job.name` and `job.schedule_display` by id. Both already loaded for Jobs tab.
- Render `OutputsByJobRow` per item:
  - 36×36 terminal icon block.
  - Job name (or `(deleted job)` if not found in jobs map).
  - Right-side day fragment of `latest.createdAt` (Today/Yesterday/Mon/Apr 24).
  - 2-line preview clamp (`numberOfLines={2}`).
  - Footer: `${count} runs · ${schedule_display}`.
  - Tap → push `/(cron)/[jobId]/outputs`.
- Empty: `EmptyState` "No runs yet — your jobs will appear here once they execute."

**New file: `frontend/app/(app)/(cron)/[jobId]/outputs.tsx`**
- Header card: `FROM JOB` micro-label, clock icon + `job.name` + `schedule_display · {count} runs`.
- List: `useQuery(cronKeys.outputs(jobId), () => listOutputs(jobId))`. Reuse existing endpoint.
- Row: `ts (mono)` · chevron · 2-line preview.
- Tap row → push `/(cron)/[jobId]/output/[outputId]`.
- Empty: `EmptyState` "No runs yet".

**Update `CronDetail` (`(cron)/[jobId]/index.tsx`):**
- Keep "Recent runs" section (top 4) with `See all` → push `/(cron)/[jobId]/outputs`.
- No other changes.

---

### Phase 5 — Realtime + polish

- **WebSocket invalidation**: extend the existing `job.run.completed` handler (find via `rg "job.run.completed"` in `src/ws/`) to invalidate both `cronKeys.outputs(jobId)` and `cronKeys.outputsByJob()`. This makes the new Outputs tab live.
- **First-row flash**: on `CronJobOutputs`, when a new output prepends (compare query data length pre/post invalidation), animate a 200ms `theme.accentBg` background pulse on row[0] using `Animated`.
- **Pull-to-refresh** on both tabs (Jobs already has it; mirror for Outputs).
- **Skeletons**: 3-row skeleton for Outputs tab + CronJobOutputs.
- **Deleted-job affordance**: in `OutputsByJobRow`, when no `job` match, render a subtle `theme.ink3` `archived` chip next to the name.

---

### Phase 6 — Acceptance pass + cleanup

Walk the spec's §9 acceptance checklist on a real device:
- [ ] Cron tab opens to Jobs.
- [ ] Outputs tab subtitle + hidden `+`.
- [ ] Job tap → CronDetail; Outputs row tap → CronJobOutputs.
- [ ] CronJobOutputs header card + sorted list.
- [ ] Output reader unchanged (existing screen reused).
- [ ] CronEditor save validation.
- [ ] Hairline dividers, safe area, 60px bottom pad.

Remove dead code if any; commit; ship OTA via EAS Update (existing pipeline).

---

## 2. Risks / open questions (decide before Phase 1)

1. **Deleted-job outputs** — keep on disk + show in Outputs tab with badge, or sweep on delete? Default: keep.
2. **Preview cost** — reading first ~200 bytes of every md file on each `/cron/outputs/by-job` call. Cheap at current scale (single user, <1000 files). Add a simple `mtime`-keyed in-memory cache later if it shows up in profiling.
3. **One-shot crons** — backend auto-deletes after run (`jobs.py:699-702`). Their outputs survive on disk → will surface in Outputs tab as deleted-job rows. Confirm UX is acceptable (matches spec intent: outputs are the artifact, jobs are the subscription).
4. **Pagination on CronJobOutputs** — daily job × 6 months = ~180 rows, all loaded. Acceptable for MVP. If a user has truly long histories, add a limit + cursor later. Not blocking.
5. **Concurrency** — agent already runs jobs in parallel (`scheduler.py` ThreadPoolExecutor, configurable via `HERMES_CRON_MAX_PARALLEL`). No mobile-side change needed; the running pill animation already covers the "multiple running at once" case.

---

## 3. File-touch summary

```
backend/src/hermes/cron-fs.ts                    [+] aggregator + preview extraction
backend/src/hermes/cron-fs.test.ts               [new] unit tests
backend/src/routes/cron.ts                       [+] GET /cron/outputs/by-job

frontend/src/api/types.ts                        [+] JobOutputSummary types
frontend/src/api/cron.ts                         [+] listOutputsByJob, key

frontend/src/components/cron/JobRow.tsx          [new, extracted]
frontend/src/components/cron/OutputsByJobRow.tsx [new]

frontend/app/(app)/(cron)/index.tsx              [refactor] SegControl + 2 bodies
frontend/app/(app)/(cron)/[jobId]/outputs.tsx    [new] CronJobOutputs
frontend/app/(app)/(cron)/[jobId]/index.tsx      [edit] "See all" → outputs route

frontend/src/ws/<existing handler>               [edit] invalidate outputsByJob too
```

---

## 4. Estimate

- Phase 1 (backend): 0.5 day
- Phase 2 (api client): 0.5 hr
- Phase 3 (segcontrol refactor): 0.5 day
- Phase 4 (Outputs tab + CronJobOutputs): 0.5 day
- Phase 5 (realtime/polish): 0.5 day
- Phase 6 (acceptance): 0.5 day

Total: ~2.5 days of focused work.
