CREATE TABLE `cron_job_bindings` (
	`cron_job_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`app_session_id` text NOT NULL,
	`output_kind` text NOT NULL,
	`hermes_session_id` text,
	`notify_on_run` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`app_session_id`) REFERENCES `app_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `cron_job_bindings_user_idx` ON `cron_job_bindings` (`user_id`);--> statement-breakpoint
CREATE INDEX `cron_job_bindings_session_idx` ON `cron_job_bindings` (`app_session_id`);--> statement-breakpoint
ALTER TABLE `app_sessions` ADD `kind` text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE `app_sessions` ADD `cron_job_id` text;--> statement-breakpoint
CREATE INDEX `app_sessions_kind_idx` ON `app_sessions` (`kind`);