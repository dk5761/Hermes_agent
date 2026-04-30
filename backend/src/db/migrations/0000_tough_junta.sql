CREATE TABLE `app_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`hermes_session_id` text,
	`title_override` text,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `app_sessions_user_archived_idx` ON `app_sessions` (`user_id`,`archived_at`);--> statement-breakpoint
CREATE INDEX `app_sessions_hermes_session_idx` ON `app_sessions` (`hermes_session_id`);--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`app_session_id` text,
	`blob_id` text NOT NULL,
	`kind` text NOT NULL,
	`thumb_blob_id` text,
	`derived_text_blob_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`app_session_id`) REFERENCES `app_sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`blob_id`) REFERENCES `blob_objects`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`thumb_blob_id`) REFERENCES `blob_objects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`derived_text_blob_id`) REFERENCES `blob_objects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `attachments_session_idx` ON `attachments` (`app_session_id`);--> statement-breakpoint
CREATE INDEX `attachments_blob_idx` ON `attachments` (`blob_id`);--> statement-breakpoint
CREATE TABLE `blob_objects` (
	`id` text PRIMARY KEY NOT NULL,
	`bucket` text NOT NULL,
	`object_key` text NOT NULL,
	`sha256` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`original_name` text,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `blob_objects_object_key_idx` ON `blob_objects` (`object_key`);--> statement-breakpoint
CREATE INDEX `blob_objects_sha256_idx` ON `blob_objects` (`sha256`);--> statement-breakpoint
CREATE INDEX `blob_objects_user_idx` ON `blob_objects` (`user_id`);--> statement-breakpoint
CREATE TABLE `cron_prefs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`hermes_job_id` text NOT NULL,
	`notify_on_complete` integer DEFAULT 0 NOT NULL,
	`last_seen_output_id` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cron_prefs_user_job_idx` ON `cron_prefs` (`user_id`,`hermes_job_id`);--> statement-breakpoint
CREATE INDEX `cron_prefs_job_idx` ON `cron_prefs` (`hermes_job_id`);--> statement-breakpoint
CREATE TABLE `derived_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_blob_id` text NOT NULL,
	`kind` text NOT NULL,
	`blob_id` text NOT NULL,
	`meta_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`parent_blob_id`) REFERENCES `blob_objects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`blob_id`) REFERENCES `blob_objects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `derived_artifacts_parent_idx` ON `derived_artifacts` (`parent_blob_id`);--> statement-breakpoint
CREATE TABLE `message_meta` (
	`id` text PRIMARY KEY NOT NULL,
	`app_session_id` text NOT NULL,
	`client_message_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`app_session_id`) REFERENCES `app_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `message_meta_session_idx` ON `message_meta` (`app_session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `message_meta_session_client_idx` ON `message_meta` (`app_session_id`,`client_message_id`);--> statement-breakpoint
CREATE TABLE `push_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expo_token` text NOT NULL,
	`platform` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_tokens_expo_token_idx` ON `push_tokens` (`expo_token`);--> statement-breakpoint
CREATE INDEX `push_tokens_user_idx` ON `push_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `refresh_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `refresh_tokens_token_hash_idx` ON `refresh_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `refresh_tokens_user_idx` ON `refresh_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE TABLE `ws_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`app_session_id` text NOT NULL,
	`type` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`app_session_id`) REFERENCES `app_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ws_events_session_id_idx` ON `ws_events` (`app_session_id`,`id`);--> statement-breakpoint
CREATE INDEX `ws_events_created_at_idx` ON `ws_events` (`created_at`);