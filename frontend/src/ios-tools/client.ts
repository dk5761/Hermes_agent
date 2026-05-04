/**
 * client.ts — thin in-app debug wrapper around the native module.
 *
 * Provides a uniform `callTool(name, args)` interface that mirrors what the
 * WS handler does, but can be driven directly from JS (e.g. a debug screen)
 * without going through the gateway WS.
 *
 * This intentionally does NOT implement retry, queuing, or the WS bridge —
 * those concerns live in handler.ts. This is purely for local invocation.
 */

import IosTools from "ios-tools";
import type { IosToolsNativeModule } from "ios-tools";
import type {
  AddEventArgs,
  AddReminderArgs,
  CompleteReminderArgs,
  DeleteEventArgs,
  ListEventsArgs,
  ListRemindersArgs,
  RunShortcutArgs,
  SendLocalNotificationArgs,
} from "../../modules/ios-tools/src/types";
import { ensurePermission } from "./permissions";
import type { IosToolName, PermissionCategory } from "./types";

// ─── Dispatch table (mirrors handler.ts) ─────────────────────────────────────

type ClientEntry = {
  permission: PermissionCategory | null;
  invoke: (args: Record<string, unknown>) => Promise<unknown>;
};

function cast<T>(args: Record<string, unknown>): T {
  return args as unknown as T;
}

function buildClientTable(): Record<IosToolName, ClientEntry> {
  const module: IosToolsNativeModule = IosTools;
  return {
    "ios.calendar.add_event": {
      permission: "calendar",
      invoke: (args) => module.addEvent(cast<AddEventArgs>(args)),
    },
    "ios.calendar.delete_event": {
      permission: "calendar",
      invoke: (args) => module.deleteEvent(cast<DeleteEventArgs>(args)),
    },
    "ios.calendar.list_events": {
      permission: "calendar",
      invoke: (args) => module.listEvents(cast<ListEventsArgs>(args)),
    },
    "ios.reminders.add": {
      permission: "reminders",
      invoke: (args) => module.addReminder(cast<AddReminderArgs>(args)),
    },
    "ios.reminders.complete": {
      permission: "reminders",
      invoke: (args) => module.completeReminder(cast<CompleteReminderArgs>(args)),
    },
    "ios.reminders.list": {
      permission: "reminders",
      invoke: (args) => module.listReminders(cast<ListRemindersArgs>(args)),
    },
    "ios.notification.send": {
      permission: "notifications",
      invoke: (args) =>
        module.sendLocalNotification(cast<SendLocalNotificationArgs>(args)),
    },
    "ios.shortcut.run": {
      permission: null,
      invoke: (args) => module.runShortcut(cast<RunShortcutArgs>(args)),
    },
  };
}

const CLIENT_TABLE = buildClientTable();

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Invoke any iOS tool by name with arbitrary args.
 *
 * Handles permission pre-check (prompts on first call per category).
 * Throws IosToolPermissionError if the user denies or has restricted access.
 * Throws the native module's error unchanged for all other failures.
 *
 * @param name - One of the IosToolName values.
 * @param args - Tool-specific arguments (see ios-tools module types).
 * @returns The tool's result typed as T. The caller is responsible for
 *          casting to the correct result type.
 */
export async function callTool<T>(
  name: IosToolName,
  args: Record<string, unknown>,
): Promise<T> {
  const entry = CLIENT_TABLE[name];
  if (entry.permission !== null) {
    await ensurePermission(entry.permission);
  }
  return entry.invoke(args) as Promise<T>;
}
