import { uploadFile } from "../api/uploads";
import type { AttachmentDTO } from "../api/types";
import type { LocalFileInput } from "./types";

// Tiny p-limit-equivalent. Keeping concurrency small (3) avoids saturating
// mobile uplinks while still letting the user batch a few photos.
const MAX_CONCURRENCY = 3;

export interface QueueCallbacks {
  onStart: (localId: string) => void;
  onSuccess: (localId: string, dto: AttachmentDTO) => void;
  onError: (localId: string, message: string) => void;
}

interface QueueEntry {
  localId: string;
  appSessionId: string;
  input: LocalFileInput;
  controller: AbortController;
}

// Singleton queue: process is shared across screens / sessions but tracks
// each entry by its localId so per-session pending stores stay independent.
class UploadQueue {
  private readonly waiting: QueueEntry[] = [];
  private readonly active = new Map<string, QueueEntry>();
  private callbacks: QueueCallbacks | null = null;

  setCallbacks(cb: QueueCallbacks): void {
    this.callbacks = cb;
  }

  enqueue(
    localId: string,
    appSessionId: string,
    input: LocalFileInput,
  ): AbortController {
    // If already enqueued or in-flight, reuse the existing controller.
    const existing =
      this.active.get(localId) ??
      this.waiting.find((e) => e.localId === localId);
    if (existing) return existing.controller;
    const entry: QueueEntry = {
      localId,
      appSessionId,
      input,
      controller: new AbortController(),
    };
    this.waiting.push(entry);
    this.pump();
    return entry.controller;
  }

  cancel(localId: string): void {
    const idx = this.waiting.findIndex((e) => e.localId === localId);
    if (idx >= 0) {
      const [removed] = this.waiting.splice(idx, 1);
      removed.controller.abort();
      return;
    }
    const live = this.active.get(localId);
    if (live) live.controller.abort();
  }

  private pump(): void {
    while (this.active.size < MAX_CONCURRENCY && this.waiting.length > 0) {
      const entry = this.waiting.shift();
      if (!entry) break;
      this.active.set(entry.localId, entry);
      void this.run(entry);
    }
  }

  private async run(entry: QueueEntry): Promise<void> {
    this.callbacks?.onStart(entry.localId);
    try {
      const dto = await uploadFile(entry.input, {
        appSessionId: entry.appSessionId,
        signal: entry.controller.signal,
      });
      this.callbacks?.onSuccess(entry.localId, dto);
    } catch (err: unknown) {
      const aborted = entry.controller.signal.aborted;
      const message = aborted
        ? "canceled"
        : err instanceof Error
          ? err.message
          : "upload failed";
      this.callbacks?.onError(entry.localId, message);
    } finally {
      this.active.delete(entry.localId);
      this.pump();
    }
  }
}

export const uploadQueue = new UploadQueue();
