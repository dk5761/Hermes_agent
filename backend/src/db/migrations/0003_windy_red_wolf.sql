CREATE TABLE `live_activity_tokens` (
	`activity_id` text PRIMARY KEY NOT NULL,
	`app_session_id` text NOT NULL,
	`user_id` text NOT NULL,
	`push_token` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`app_session_id`) REFERENCES `app_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `live_activity_tokens_session_idx` ON `live_activity_tokens` (`app_session_id`);