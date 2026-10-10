-- Comments on shared files (docs/multiplayer.md §10; Figma's Comment: id, parent_id, user, created_at, resolved_at,
-- message, order_id, client_meta, reactions). A thread is its first comment (thread_id = id) and the replies to it;
-- the first comment holds the thread's place (page point, optionally a layer and the offset from its top-left), its
-- number in the file and its resolve state. Deleting the first comment deletes the thread.
CREATE TABLE comments (
  id          TEXT PRIMARY KEY,
  file_key    TEXT NOT NULL REFERENCES files (key) ON DELETE CASCADE,
  thread_id   TEXT NOT NULL REFERENCES comments (id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users (id),
  message     TEXT NOT NULL,
  mentions    TEXT NOT NULL DEFAULT '[]',
  number      INTEGER,
  page_id     TEXT,
  x           REAL,
  y           REAL,
  node_id     TEXT,
  offset_x    REAL,
  offset_y    REAL,
  created_at  INTEGER NOT NULL,
  edited_at   INTEGER,
  resolved_at INTEGER,
  resolved_by TEXT REFERENCES users (id)
);
CREATE INDEX comments_file ON comments (file_key, created_at);
CREATE INDEX comments_thread ON comments (thread_id);

CREATE TABLE comment_reactions (
  comment_id TEXT NOT NULL REFERENCES comments (id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users (id),
  emoji      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (comment_id, user_id, emoji)
);

-- When each person last read each thread ("Mark as unread" sets it back to 0).
CREATE TABLE comment_reads (
  thread_id TEXT NOT NULL REFERENCES comments (id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users (id),
  read_at   INTEGER NOT NULL,
  PRIMARY KEY (thread_id, user_id)
);
