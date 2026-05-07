ALTER TABLE `chat_history` ADD `audio_blob_path` text;--> statement-breakpoint
ALTER TABLE `chat_history` ADD `audio_duration_ms` integer;--> statement-breakpoint
ALTER TABLE `chat_history` ADD `transcription_status` text;--> statement-breakpoint
ALTER TABLE `chat_history` ADD `transcription_error` text;--> statement-breakpoint
CREATE INDEX `chat_history_audio_idx` ON `chat_history` (`audio_blob_path`) WHERE audio_blob_path IS NOT NULL;