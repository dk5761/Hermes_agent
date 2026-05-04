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

// ---------------------------------------------------------------------------
// Calendar writes
// ---------------------------------------------------------------------------

export interface AddEventArgs {
  title: string;
  /** Epoch ms of event start. */
  startMs: number;
  /** Epoch ms of event end. Must be > startMs and within 4 years of startMs. */
  endMs: number;
  /** Calendar identifier from listCalendars(). Uses default if omitted. */
  calendarId?: string;
  notes?: string;
  /** Defaults to false. */
  allDay?: boolean;
}

export interface AddEventResult {
  /** The newly created event's EKEvent identifier. */
  id: string;
}

export interface DeleteEventArgs {
  /** Event identifier from listEvents() or addEvent(). */
  id: string;
}

export interface DeleteEventResult {
  ok: true;
}

// ---------------------------------------------------------------------------
// Reminders writes
// ---------------------------------------------------------------------------

export interface AddReminderArgs {
  title: string;
  /** Epoch ms of the due date. No due date if omitted. */
  dueDateMs?: number;
  /** Reminder-list identifier from listReminderLists(). Uses default if omitted. */
  listId?: string;
  notes?: string;
}

export interface AddReminderResult {
  /** The newly created reminder's EKCalendarItem identifier. */
  id: string;
}

export interface CompleteReminderArgs {
  /** Reminder identifier from listReminders() or addReminder(). */
  id: string;
}

export interface CompleteReminderResult {
  ok: true;
}

// ---------------------------------------------------------------------------
// Notifications write
// ---------------------------------------------------------------------------

export interface SendLocalNotificationArgs {
  title: string;
  body: string;
  /**
   * Optional epoch ms at which to fire the notification.
   * If omitted or in the past, the notification is delivered immediately.
   */
  fireAtMs?: number;
}

export interface SendLocalNotificationResult {
  /** The UNNotificationRequest identifier (UUID). */
  id: string;
}

// ---------------------------------------------------------------------------
// Shortcuts launcher
// ---------------------------------------------------------------------------

export interface RunShortcutArgs {
  /** Exact name of the shortcut as it appears in the Shortcuts app. */
  name: string;
  /** Optional string input forwarded to the shortcut. */
  input?: string;
}

/**
 * `ok: true` means the `shortcuts://` URL was successfully opened.
 * It does NOT guarantee the shortcut ran to completion (the app is
 * backgrounded once Shortcuts.app opens).
 */
export interface RunShortcutResult {
  ok: true;
}
