CREATE TABLE `user_prefs` (
	`user_id` text PRIMARY KEY NOT NULL,
	`notify_chat_complete` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
