/**
 * voice-memo-uploader — upload coordinator for the pending-memos queue.
 *
 * Responsibilities:
 *   - POST a single pending memo to the backend via postVoiceMemo.
 *   - On success: swap the optimistic chat-store ID (local-<uuid> →
 *     hist-u-<dbId>), update the bubble from the server response, remove
 *     the pending-memo entry, then delete the local audio file.
 *   - On failure: bump retries, schedule a backoff retry when online (up to
 *     MAX_RETRIES times). After the cap, mark the entry "failed" so the
 *     bubble shows a retry CTA.
 *   - drainPendingMemos(): replay every non-failed memo. Called at cold
 *     start and on offline→online transitions.
 *
 * Two-step commit order on success (Phase 1 constraint §1):
 *   1. renameMessage(localId, serverId)  — swap chat-store key in-place.
 *   2. remove(memoId)                   — remove from pending queue.
 *   3. deleteFile(localAudioUri)         — delete disk file.
 * If step 1 throws (store not found, id already replaced) we still remove
 * and delete — the bubble is no longer "local" so the file is orphaned.
 */

import { File } from "expo-file-system";
import { postVoiceMemo, VoiceMemoError, type VoiceMemoMessage } from "../api/voice-memo";
import { useChatStore } from "../state/chat-store";
import { usePendingMemos, MAX_RETRIES } from "../state/pending-memos";
import { useNetworkStatus } from "../state/network-status";
import { showToast } from "../components/ui/Toast";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Exponential backoff schedule (ms). Index = number of completed retries. */
const BACKOFF_MS: [number, number, number] = [1_000, 5_000, 30_000];

function safeDeleteFile(uri: string): void {
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // Best-effort — log to console but never throw.
    console.warn("[voice-uploader] could not delete local audio:", uri);
  }
}

// ---------------------------------------------------------------------------
// Core uploader
// ---------------------------------------------------------------------------

/**
 * Upload a single pending memo by id.
 *
 * Success path (in order):
 *   1. Rename optimistic chat-store entry (local-id → hist-u-<dbId>).
 *   2. Update bubble fields from server response.
 *   3. Remove from pending-memos store.
 *   4. Delete local audio file.
 *
 * @param memoId - The "local-<uuid>" id of the pending memo to upload.
 */
export async function uploadPendingMemo(memoId: string): Promise<void> {
  const store = usePendingMemos.getState();
  const memo = store.byId[memoId];
  if (!memo) return; // already removed or id mismatch
  if (memo.status === "failed") return; // user must explicitly retry

  store.markUploading(memoId);

  let serverMsg;
  try {
    serverMsg = await postVoiceMemo(
      memo.sessionId,
      memo.localAudioUri,
      memo.durationMs,
      memo.peaks,
    );
  } catch (err) {
    // Determine if this is worth retrying.
    const isPermFail =
      err instanceof VoiceMemoError &&
      (err.status === 404 || err.status === 401 || err.status === 403);

    const errorMsg =
      err instanceof Error ? err.message : "Upload failed";

    // markFailed bumps retries in the store atomically.
    usePendingMemos.getState().markFailed(memoId, errorMsg);
    // Read updated retries count after the bump.
    const updatedMemo = usePendingMemos.getState().byId[memoId];
    const nextRetries = updatedMemo?.retries ?? MAX_RETRIES;

    if (isPermFail || nextRetries >= MAX_RETRIES) {
      // Permanent failure (session deleted, auth, or retry cap reached).
      // Reflect failure state in the chat bubble.
      _updateBubbleStatus(memo.sessionId, memoId, "failed");
      if (isPermFail && err instanceof VoiceMemoError && err.status === 404) {
        showToast("Session no longer exists — memo discarded", "warning");
        usePendingMemos.getState().remove(memoId);
      }
    } else {
      // Transient failure: schedule a backoff retry.
      const delay = BACKOFF_MS[Math.min(nextRetries - 1, 2)] ?? 30_000;
      setTimeout(() => {
        // Check network before retrying.
        if (!useNetworkStatus.getState().online) {
          // Network subscriber in _layout.tsx will call drainPendingMemos on
          // the next online transition — no need to schedule further here.
          return;
        }
        // Re-read memo to pick up state after the flush.
        const fresh = usePendingMemos.getState().byId[memoId];
        if (!fresh || fresh.retries >= MAX_RETRIES) return;
        usePendingMemos.getState().markUploading(memoId);
        void uploadPendingMemo(memoId);
      }, delay);
    }
    return;
  }

  // ── Success path ──────────────────────────────────────────────────────────
  const serverId = `hist-u-${serverMsg.id}`;

  // Step 1: rename the optimistic chat-store entry in-place.
  try {
    useChatStore.getState().renameMessage(memo.sessionId, memoId, serverId);
  } catch {
    // Store may have been reset (e.g., session navigated away). Non-fatal.
  }

  // Step 2: update the bubble's audio metadata from the server response.
  _applyServerResponse(memo.sessionId, serverId, serverMsg);

  // Step 3: remove from pending queue.
  usePendingMemos.getState().remove(memoId);

  // Step 4: delete the local audio file (AFTER queue entry removed).
  safeDeleteFile(memo.localAudioUri);
}

// ---------------------------------------------------------------------------
// Drain
// ---------------------------------------------------------------------------

/**
 * Drain every non-failed pending memo, serialised.
 *
 * Called at app cold-start (after hydrate + network confirmed online) and
 * whenever the network flips offline → online.
 */
export async function drainPendingMemos(): Promise<void> {
  if (!useNetworkStatus.getState().online) return;
  const byId = usePendingMemos.getState().byId;
  for (const memo of Object.values(byId)) {
    if (memo.status === "failed") continue;
    // Await each sequentially — avoids concurrent STT load on server.
    await uploadPendingMemo(memo.id).catch(console.warn);
  }
}

// ---------------------------------------------------------------------------
// Private helpers — chat-store bubble updates
// ---------------------------------------------------------------------------

/**
 * Update the transcriptionStatus on the optimistic bubble to reflect a
 * terminal upload failure.
 */
function _updateBubbleStatus(
  sessionId: string,
  messageId: string,
  status: "failed",
): void {
  useChatStore.setState((s) => {
    const session = s.byId[sessionId];
    if (!session) return s;
    const idx = session.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return s;
    const existing = session.messages[idx];
    if (!existing || existing.kind !== "user") return s;
    const msgs = session.messages.slice();
    msgs[idx] = { ...existing, transcriptionStatus: status };
    return {
      byId: {
        ...s.byId,
        [sessionId]: { ...session, messages: msgs },
      },
    };
  });
}

/**
 * Apply the server response fields to the renamed bubble.
 * The bubble already has the new serverId at this point.
 */
function _applyServerResponse(
  sessionId: string,
  serverId: string,
  serverMsg: VoiceMemoMessage,
): void {
  useChatStore.setState((s) => {
    const session = s.byId[sessionId];
    if (!session) return s;
    const idx = session.messages.findIndex((m) => m.id === serverId);
    if (idx === -1) return s;
    const existing = session.messages[idx];
    if (!existing || existing.kind !== "user") return s;
    const msgs = session.messages.slice();
    msgs[idx] = {
      ...existing,
      text: serverMsg.content,
      audioBlobUrl: serverMsg.audioBlobUrl,
      audioDurationMs: serverMsg.audioDurationMs,
      transcriptionStatus: serverMsg.transcriptionStatus,
      ...(serverMsg.transcriptionError
        ? { transcriptionError: serverMsg.transcriptionError }
        : {}),
      ...(serverMsg.audioPeaks != null
        ? { audioPeaks: serverMsg.audioPeaks }
        : {}),
      // Clear local URI now that the server blob is canonical.
      localAudioUri: undefined,
      createdAt: new Date(serverMsg.createdAt * 1000).toISOString(),
    };
    return {
      byId: {
        ...s.byId,
        [sessionId]: { ...session, messages: msgs },
      },
    };
  });
}
