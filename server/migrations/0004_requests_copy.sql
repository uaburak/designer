-- "Ask to edit" requests and "Viewers can copy, save, and export from this file" (docs/multiplayer.md §3).
CREATE TABLE access_requests (
  file_key   TEXT NOT NULL REFERENCES files (key) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users (id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (file_key, user_id)
);
ALTER TABLE files ADD COLUMN viewers_can_copy INTEGER NOT NULL DEFAULT 1;
