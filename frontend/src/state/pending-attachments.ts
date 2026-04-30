import { create } from "zustand";
import { uploadQueue } from "../attachments/upload-queue";
import type {
  LocalFileInput,
  PendingAttachment,
  PendingStatus,
} from "../attachments/types";
import type { AttachmentDTO } from "../api/types";

// Pending attachments are keyed per app session to mirror the chat-store
// layout. The composer reads only its own session's list.

interface PendingState {
  bySession: Record<string, PendingAttachment[]>;
  add: (appSessionId: string, inputs: LocalFileInput[]) => void;
  retry: (appSessionId: string, localId: string) => void;
  remove: (appSessionId: string, localId: string) => void;
  clearSession: (appSessionId: string) => void;
  // Wired by the queue callbacks so we don't import the store inside the queue.
  markStatus: (
    localId: string,
    status: PendingStatus,
    extras?: { dto?: AttachmentDTO; error?: string },
  ) => void;
}

function genLocalId(): string {
  return `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function findEntry(
  state: PendingState["bySession"],
  localId: string,
): { sessionId: string; index: number } | null {
  for (const [sessionId, list] of Object.entries(state)) {
    const idx = list.findIndex((p) => p.localId === localId);
    if (idx >= 0) return { sessionId, index: idx };
  }
  return null;
}

export const usePendingAttachments = create<PendingState>((set, get) => ({
  bySession: {},

  add(appSessionId, inputs) {
    if (inputs.length === 0) return;
    const now = Date.now();
    const newEntries: PendingAttachment[] = inputs.map((input) => ({
      localId: genLocalId(),
      appSessionId,
      status: "queued" as const,
      input,
      attachment: null,
      error: null,
      progress: 0,
      createdAt: now,
    }));
    set((s) => ({
      bySession: {
        ...s.bySession,
        [appSessionId]: [...(s.bySession[appSessionId] ?? []), ...newEntries],
      },
    }));
    for (const entry of newEntries) {
      uploadQueue.enqueue(entry.localId, appSessionId, entry.input);
    }
  },

  retry(appSessionId, localId) {
    const list = get().bySession[appSessionId];
    if (!list) return;
    const entry = list.find((p) => p.localId === localId);
    if (!entry) return;
    if (entry.status !== "failed") return;
    set((s) => ({
      bySession: {
        ...s.bySession,
        [appSessionId]: (s.bySession[appSessionId] ?? []).map((p) =>
          p.localId === localId
            ? { ...p, status: "queued", error: null, progress: 0 }
            : p,
        ),
      },
    }));
    uploadQueue.enqueue(localId, appSessionId, entry.input);
  },

  remove(appSessionId, localId) {
    // Cancel mid-flight; the queue's onError("canceled") still fires but the
    // entry will already be gone — markStatus handles the missing-id case.
    uploadQueue.cancel(localId);
    set((s) => ({
      bySession: {
        ...s.bySession,
        [appSessionId]: (s.bySession[appSessionId] ?? []).filter(
          (p) => p.localId !== localId,
        ),
      },
    }));
  },

  clearSession(appSessionId) {
    set((s) => {
      if (!s.bySession[appSessionId]) return s;
      const { [appSessionId]: _removed, ...rest } = s.bySession;
      return { bySession: rest };
    });
  },

  markStatus(localId, status, extras) {
    set((s) => {
      const found = findEntry(s.bySession, localId);
      if (!found) return s;
      const list = s.bySession[found.sessionId] ?? [];
      const next = list.map((p) =>
        p.localId === localId
          ? {
              ...p,
              status,
              attachment: extras?.dto ?? p.attachment,
              error: extras?.error ?? (status === "failed" ? p.error : null),
            }
          : p,
      );
      return {
        bySession: { ...s.bySession, [found.sessionId]: next },
      };
    });
  },
}));

// Wire the queue once at module load. Keeping this here avoids a circular
// import between the queue and the store.
uploadQueue.setCallbacks({
  onStart: (localId) => {
    usePendingAttachments.getState().markStatus(localId, "uploading");
  },
  onSuccess: (localId, dto) => {
    usePendingAttachments.getState().markStatus(localId, "uploaded", { dto });
  },
  onError: (localId, message) => {
    if (message === "canceled") {
      // Entry was removed locally; nothing to mark.
      return;
    }
    usePendingAttachments
      .getState()
      .markStatus(localId, "failed", { error: message });
  },
});
