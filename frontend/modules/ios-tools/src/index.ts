/**
 * ios-tools module entry point.
 *
 * Re-exports the native module default export and all public types.
 * Import this from application code:
 *
 *   import IosTools from "ios-tools";
 *   import type { EventDto, CalendarDto } from "ios-tools";
 */

export { default } from "./IosToolsModule";
export type { IosToolsNativeModule } from "./IosToolsModule";
export type {
  CalendarDto,
  CalendarType,
  EventDto,
  ListEventsArgs,
  ListRemindersArgs,
  NotificationPermissionStatus,
  PermissionStatus,
  ReminderDto,
  ReminderFilter,
  ReminderListDto,
} from "./types";
