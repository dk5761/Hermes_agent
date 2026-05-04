/**
 * JS-side typed wrapper around the "IosTools" Expo native module.
 *
 * Loaded lazily at runtime. If the native module is absent (Expo Go,
 * Android, simulator without a dev-client rebuild) every method falls
 * back to a stub that throws `"unsupported"` so callers know they need
 * a real device + dev build.
 *
 * Phase 3 will add a higher-level client on top of this that handles
 * permission pre-checks, caching, and the offline queue. This file
 * intentionally stays thin — it is a 1:1 reflection of the Swift API.
 */

import { NativeModulesProxy, requireNativeModule } from "expo-modules-core";
import type {
  CalendarDto,
  EventDto,
  ListEventsArgs,
  ListRemindersArgs,
  NotificationPermissionStatus,
  PermissionStatus,
  ReminderDto,
  ReminderListDto,
} from "./types";

// ---------------------------------------------------------------------------
// Native interface (mirrors IosToolsModule.swift definition)
// ---------------------------------------------------------------------------

interface IosToolsNativeModule {
  // Permissions
  requestCalendarPermission(): Promise<PermissionStatus>;
  getCalendarPermissionStatus(): Promise<PermissionStatus>;
  requestRemindersPermission(): Promise<PermissionStatus>;
  getRemindersPermissionStatus(): Promise<PermissionStatus>;
  requestNotificationsPermission(): Promise<NotificationPermissionStatus>;

  // Calendar reads
  listCalendars(): Promise<CalendarDto[]>;
  listEvents(args: ListEventsArgs): Promise<EventDto[]>;

  // Reminders reads
  listReminderLists(): Promise<ReminderListDto[]>;
  listReminders(args: ListRemindersArgs): Promise<ReminderDto[]>;
}

// ---------------------------------------------------------------------------
// Stub (used when native module is not available)
// ---------------------------------------------------------------------------

function makeUnsupportedError(): Error {
  const err = new Error(
    "IosTools native module is not available on this platform. " +
      "A dev-client build on a physical iOS device is required.",
  );
  (err as any).code = "unsupported";
  return err;
}

const STUB: IosToolsNativeModule = {
  requestCalendarPermission: () => Promise.reject(makeUnsupportedError()),
  getCalendarPermissionStatus: () => Promise.reject(makeUnsupportedError()),
  requestRemindersPermission: () => Promise.reject(makeUnsupportedError()),
  getRemindersPermissionStatus: () => Promise.reject(makeUnsupportedError()),
  requestNotificationsPermission: () => Promise.reject(makeUnsupportedError()),
  listCalendars: () => Promise.reject(makeUnsupportedError()),
  listEvents: () => Promise.reject(makeUnsupportedError()),
  listReminderLists: () => Promise.reject(makeUnsupportedError()),
  listReminders: () => Promise.reject(makeUnsupportedError()),
};

// ---------------------------------------------------------------------------
// Load native module
// ---------------------------------------------------------------------------

function loadNative(): IosToolsNativeModule {
  // Touching NativeModulesProxy ensures the registry is up to date.
  void NativeModulesProxy;
  try {
    return requireNativeModule<IosToolsNativeModule>("IosTools");
  } catch {
    return STUB;
  }
}

const IosTools: IosToolsNativeModule = loadNative();

export default IosTools;
export type { IosToolsNativeModule };
