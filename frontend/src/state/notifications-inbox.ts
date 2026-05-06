/**
 * Notifications inbox — local log of every push the app has ever received,
 * persisted to AsyncStorage.
 *
 * The handler in `src/notifications/handler.ts` calls `add()` on every
 * `addNotificationReceivedListener` event AND on cold-start replay. Items
 * are de-duped by Expo notification request id so re-mounting the listener
 * doesn't double-record.
 *
 * Hydration is non-blocking — we hydrate from `_layout.tsx` alongside the
 * other persisted stores. Reads against a non-hydrated store return [].
 */
import { create } from "zustand";
import { sqliteKv } from "@/state/sqlite-kv";

const KEY = "notifications.inbox.v1";
const MAX_ITEMS = 200;

export interface InboxItem {
  id: string;
  title: string;
  body: string;
  // Free-form passthrough of the push `data` field (jobId/outputId etc.).
  data: Record<string, unknown>;
  receivedAt: number; // unix ms
  read: boolean;
  archived: boolean;
}

export interface NotificationsInboxState {
  items: InboxItem[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  add: (item: Omit<InboxItem, "read" | "archived" | "receivedAt"> & {
    receivedAt?: number;
  }) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  /**
   * Mark every cron-output inbox entry whose data.outputId matches the
   * argument as read. Used by the output detail screen — tapping into an
   * output should clear its corresponding unread, even when the user
   * navigated via in-app routing rather than the push tap.
   */
  markCronOutputRead: (outputId: string) => void;
  archive: (id: string) => void;
  unarchive: (id: string) => void;
  remove: (id: string) => void;
  clearAll: () => void;
}

function isItem(v: unknown): v is InboxItem {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.title === "string" &&
    typeof r.body === "string" &&
    typeof r.receivedAt === "number" &&
    typeof r.read === "boolean" &&
    typeof r.archived === "boolean" &&
    !!r.data &&
    typeof r.data === "object"
  );
}

function parse(raw: string | null): InboxItem[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isItem);
  } catch {
    return [];
  }
}

function persist(items: InboxItem[]): void {
  void sqliteKv.setItem(KEY, JSON.stringify(items)).catch(() => undefined);
}

export const useNotificationsInbox = create<NotificationsInboxState>(
  (set, get) => ({
    items: [],
    hydrated: false,

    async hydrate() {
      if (get().hydrated) return;
      const raw = await sqliteKv.getItem(KEY);
      set({ items: parse(raw), hydrated: true });
    },

    add(input) {
      set((s) => {
        // Dedup by id — Expo replays the same id when the OS re-fires a
        // notification or when our listener mounts twice in dev.
        if (s.items.some((it) => it.id === input.id)) return s;
        const item: InboxItem = {
          id: input.id,
          title: input.title,
          body: input.body,
          data: input.data,
          receivedAt: input.receivedAt ?? Date.now(),
          read: false,
          archived: false,
        };
        const next = [item, ...s.items].slice(0, MAX_ITEMS);
        persist(next);
        return { items: next };
      });
    },

    markRead(id) {
      set((s) => {
        const next = s.items.map((it) =>
          it.id === id && !it.read ? { ...it, read: true } : it,
        );
        if (next === s.items) return s;
        persist(next);
        return { items: next };
      });
    },

    markAllRead() {
      set((s) => {
        if (s.items.every((it) => it.read)) return s;
        const next = s.items.map((it) => (it.read ? it : { ...it, read: true }));
        persist(next);
        return { items: next };
      });
    },

    markCronOutputRead(outputId) {
      set((s) => {
        let mutated = false;
        const next = s.items.map((it) => {
          if (it.read) return it;
          const d = it.data;
          if (
            d &&
            typeof d === "object" &&
            (d as Record<string, unknown>).type === "cron_output" &&
            (d as Record<string, unknown>).outputId === outputId
          ) {
            mutated = true;
            return { ...it, read: true };
          }
          return it;
        });
        if (!mutated) return s;
        persist(next);
        return { items: next };
      });
    },

    archive(id) {
      set((s) => {
        const next = s.items.map((it) =>
          it.id === id ? { ...it, archived: true, read: true } : it,
        );
        persist(next);
        return { items: next };
      });
    },

    unarchive(id) {
      set((s) => {
        const next = s.items.map((it) =>
          it.id === id ? { ...it, archived: false } : it,
        );
        persist(next);
        return { items: next };
      });
    },

    remove(id) {
      set((s) => {
        const next = s.items.filter((it) => it.id !== id);
        persist(next);
        return { items: next };
      });
    },

    clearAll() {
      persist([]);
      set({ items: [] });
    },
  }),
);
