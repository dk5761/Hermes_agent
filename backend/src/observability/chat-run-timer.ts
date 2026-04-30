// Per-chat-run timing recorder.
//
// Hermes does not assign client-visible run IDs separately from session IDs;
// for the gateway we treat (appSessionId) as the run key — only one in-flight
// run per session at a time, which matches Hermes's single-active-prompt
// invariant. If that assumption ever breaks we'd switch to a synthetic run ID
// minted on message.start.
//
// Lifecycle: recordRunStart on `message.start`, recordEvent on streamed events
// of interest, recordRunComplete on `message.complete` / abort. complete()
// flushes a structured `event:"chat_run"` log line and frees the entry.
//
// Memory bound: stale entries with no complete (client crashed mid-run) are
// reaped on a 30-minute interval. A run that ages past the limit is logged
// with status="orphaned".

import type { AppLogger } from "../logger.js";

export type ChatRunStatus = "completed" | "aborted" | "errored" | "orphaned";

export interface ChatRunStats {
  appSessionId: string;
  startedAtMs: number;
  deltaCount: number;
  toolCount: number;
}

const ORPHAN_AGE_MS = 30 * 60 * 1000;

export class ChatRunTimer {
  private readonly log: AppLogger;
  private readonly runs = new Map<string, ChatRunStats>();
  private readonly reaper: NodeJS.Timeout;

  constructor(logger: AppLogger) {
    this.log = logger.child({ component: "chat-run-timer" });
    this.reaper = setInterval(() => this.reapOrphans(), ORPHAN_AGE_MS);
    this.reaper.unref();
  }

  // Marks the start of a run. Called on `message.start`. If a previous run
  // for the session never completed it's flushed as orphaned to avoid
  // double-counting or memory leaks.
  recordRunStart(appSessionId: string): void {
    const prev = this.runs.get(appSessionId);
    if (prev) this.flush(appSessionId, prev, "orphaned");
    this.runs.set(appSessionId, {
      appSessionId,
      startedAtMs: Date.now(),
      deltaCount: 0,
      toolCount: 0,
    });
  }

  // Increments the matching counter. Tolerates events arriving before
  // recordRunStart (race on message.start delivery) by silently ignoring.
  recordEvent(appSessionId: string, type: string): void {
    const stats = this.runs.get(appSessionId);
    if (!stats) return;
    if (type === "message.delta") {
      stats.deltaCount += 1;
      return;
    }
    if (type === "tool.start" || type === "tool.complete") {
      // Each tool produces both events; counting only `tool.start` keeps the
      // metric == "tool invocations". (Renamed from toolCount=both/2 for
      // clarity.)
      if (type === "tool.start") stats.toolCount += 1;
    }
  }

  recordRunComplete(appSessionId: string, status: ChatRunStatus): void {
    const stats = this.runs.get(appSessionId);
    if (!stats) return;
    this.flush(appSessionId, stats, status);
  }

  stop(): void {
    clearInterval(this.reaper);
    // Flush whatever's left so we don't drop telemetry on shutdown.
    for (const [sid, stats] of this.runs) {
      this.flush(sid, stats, "orphaned");
    }
  }

  private flush(appSessionId: string, stats: ChatRunStats, status: ChatRunStatus): void {
    const durationMs = Date.now() - stats.startedAtMs;
    this.log.info(
      {
        event: "chat_run",
        appSessionId,
        durationMs,
        deltaCount: stats.deltaCount,
        toolCount: stats.toolCount,
        status,
      },
      "chat_run",
    );
    this.runs.delete(appSessionId);
  }

  private reapOrphans(): void {
    const now = Date.now();
    for (const [sid, stats] of this.runs) {
      if (now - stats.startedAtMs > ORPHAN_AGE_MS) {
        this.flush(sid, stats, "orphaned");
      }
    }
  }
}
