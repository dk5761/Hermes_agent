CREATE TABLE `ios_tool_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`tool` text NOT NULL,
	`args_json` text NOT NULL,
	`queued_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_attempt_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ios_tool_queue_user_idx` ON `ios_tool_queue` (`user_id`);
--> statement-breakpoint
CREATE INDEX `ios_tool_queue_queued_at_idx` ON `ios_tool_queue` (`queued_at`);
