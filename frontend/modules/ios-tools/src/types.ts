/**
 * Shared types for the ios-tools module.
 *
 * These are the canonical data-transfer shapes used by:
 *  - The native Swift layer (as [String: Any] dicts)
 *  - The JS module exports (IosToolsModule.ts)
 *  - The future backend MCP layer (Phase 5 will mirror these in
 *    backend/src/types/ios-tools.ts)
 *
 * Rule: all time values are epoch milliseconds (number), not ISO strings.
 * The Swift side converts Date <-> epochMs at the boundary.
 */

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/** Status string returned by all permission methods. */
export type PermissionStatus =
  | "granted"
  | "denied"
  | "not_determined"
  | "restricted";

/**
 * Notification permission has no "restricted" state from the JS perspective
 * (UNAuthorizationStatus.denied covers the restricted case for us).
 */
export type NotificationPermissionStatus = "granted" | "denied" | "not_determined";

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export type CalendarType =
  | "local"
  | "icloud"
  | "exchange"
  | "subscribed"
  | "birthday"
  | string;

export interface CalendarDto {
  id: string;
  title: string;
  type: CalendarType;
  isDefault: boolean;
}

export interface EventDto {
  id: string;
  title: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  notes?: string;
  calendarId: string;
  calendarTitle: string;
}

export interface ListEventsArgs {
  startMs: number;
  endMs: number;
  /** If omitted, events from all calendars are returned. */
  calendarIds?: string[];
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

export interface ReminderListDto {
  id: string;
  title: string;
  isDefault: boolean;
}

export interface ReminderDto {
  id: string;
  title: string;
  /** Epoch ms of the due date, if one is set. */
  dueMs?: number;
  completed: boolean;
  listId: string;
  listTitle: string;
  notes?: string;
}

export type ReminderFilter = "pending" | "completed" | "all";

export interface ListRemindersArgs {
  /** Defaults to "all" if omitted. */
  filter?: ReminderFilter;
  /** If omitted, reminders from all lists are returned. */
  listIds?: string[];
}
