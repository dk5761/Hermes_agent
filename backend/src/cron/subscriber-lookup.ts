// Find users subscribed to notifications for a given Hermes cron job, joined
// with their Expo push tokens. Used by the cron output watcher to fan out
// pushes per output file.

import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { cronPrefs, pushTokens } from "../db/schema.js";

export interface SubscriberRow {
  userId: string;
  prefId: string;
  lastSeenOutputId: string | null;
  expoTokens: string[];
}

export async function findSubscribersForJob(
  db: Db,
  hermesJobId: string,
): Promise<SubscriberRow[]> {
  // Pull subscribed prefs for this job. notify_on_complete is stored as
  // integer (0/1) because SQLite has no native bool.
  const prefs = await db
    .select({
      id: cronPrefs.id,
      userId: cronPrefs.userId,
      lastSeenOutputId: cronPrefs.lastSeenOutputId,
    })
    .from(cronPrefs)
    .where(
      and(
        eq(cronPrefs.hermesJobId, hermesJobId),
        eq(cronPrefs.notifyOnComplete, 1),
      ),
    );

  if (prefs.length === 0) return [];

  // Batch-fetch tokens for all subscribed users in one query.
  const userIds = prefs.map((p) => p.userId);
  const tokensByUser = new Map<string, string[]>();
  // drizzle's `inArray` would be cleaner; do it explicitly to avoid a new
  // import and to keep query count predictable for tiny user sets.
  for (const uid of userIds) {
    if (tokensByUser.has(uid)) continue;
    const rows = await db
      .select({ token: pushTokens.expoToken })
      .from(pushTokens)
      .where(eq(pushTokens.userId, uid));
    tokensByUser.set(
      uid,
      rows.map((r) => r.token),
    );
  }

  return prefs.map((p) => ({
    userId: p.userId,
    prefId: p.id,
    lastSeenOutputId: p.lastSeenOutputId,
    expoTokens: tokensByUser.get(p.userId) ?? [],
  }));
}
