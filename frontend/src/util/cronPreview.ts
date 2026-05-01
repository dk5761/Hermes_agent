/**
 * cronPreview.ts — thin wrapper around `cron-parser` that returns the next
 * N occurrences of a cron expression as JS `Date` objects, or `null` when
 * the expression is invalid. Used by the editor's "Next 3 runs" preview.
 *
 * We deliberately keep the surface tiny: callers don't need to import
 * cron-parser directly, and the parser's `CronDate` is converted to a plain
 * `Date` so consumers stay free of library types.
 */
import { CronExpressionParser } from "cron-parser";

/** Returns true if the expression parses; false otherwise. Cheap validation. */
export function isValidCron(expression: string): boolean {
  try {
    CronExpressionParser.parse(expression);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute the next `count` runs of a cron expression starting from `now`.
 * Returns `null` on invalid input so the caller can show an inline error
 * instead of throwing through React Query / render.
 */
export function nextRuns(
  expression: string,
  count = 3,
  now: Date = new Date(),
): Date[] | null {
  try {
    const iter = CronExpressionParser.parse(expression, { currentDate: now });
    const out: Date[] = [];
    for (let i = 0; i < count; i += 1) {
      out.push(iter.next().toDate());
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Format a Date for the preview row. Targets the same look as the prototype:
 * weekday + HH:mm for runs in the next 6 days, MMM dd otherwise.
 */
export function formatPreview(d: Date, now: Date = new Date()): string {
  const diffDays = Math.floor((d.getTime() - now.getTime()) / 86_400_000);
  const time = d
    .toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
    .replace(/^24/, "00");
  if (diffDays === 0) return `today · ${time}`;
  if (diffDays === 1) return `tomorrow · ${time}`;
  if (diffDays > 1 && diffDays < 7) {
    const weekday = d.toLocaleDateString([], { weekday: "short" });
    return `${weekday} · ${time}`;
  }
  const md = d.toLocaleDateString([], { month: "short", day: "2-digit" });
  return `${md} · ${time}`;
}
