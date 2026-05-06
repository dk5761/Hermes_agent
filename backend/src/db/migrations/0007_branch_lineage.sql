ALTER TABLE app_sessions ADD COLUMN parent_app_session_id TEXT REFERENCES app_sessions(id);
--> statement-breakpoint
CREATE INDEX app_sessions_parent_idx ON app_sessions(parent_app_session_id);
