ALTER TABLE chat_history ADD COLUMN search_text TEXT;
--> statement-breakpoint
CREATE VIRTUAL TABLE chat_history_fts USING fts5(
  app_session_id  UNINDEXED,
  search_text,
  content='chat_history',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE TRIGGER chat_history_fts_ai AFTER INSERT ON chat_history BEGIN
  INSERT INTO chat_history_fts(rowid, app_session_id, search_text)
    VALUES (new.id, new.app_session_id, COALESCE(new.search_text, ''));
END;
--> statement-breakpoint
CREATE TRIGGER chat_history_fts_ad AFTER DELETE ON chat_history BEGIN
  INSERT INTO chat_history_fts(chat_history_fts, rowid, app_session_id, search_text)
    VALUES('delete', old.id, old.app_session_id, COALESCE(old.search_text, ''));
END;
--> statement-breakpoint
CREATE TRIGGER chat_history_fts_au AFTER UPDATE ON chat_history BEGIN
  INSERT INTO chat_history_fts(chat_history_fts, rowid, app_session_id, search_text)
    VALUES('delete', old.id, old.app_session_id, COALESCE(old.search_text, ''));
  INSERT INTO chat_history_fts(rowid, app_session_id, search_text)
    VALUES (new.id, new.app_session_id, COALESCE(new.search_text, ''));
END;
