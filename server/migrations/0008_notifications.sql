-- Notifications (docs/multiplayer.md §12; src/shared/notifications.ts): Figma's bell — comments, replies, @mentions and
-- reactions on files you're in, invites, requests to edit and their answers, ownership transferred to you. One row per
-- person; like events fold into one unread row ("4 comments · <file>", "2 reactions · <file>") within 30 minutes.
CREATE TABLE notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  file_key   TEXT REFERENCES files (key) ON DELETE CASCADE,
  file_name  TEXT NOT NULL DEFAULT '',
  actor_id   TEXT NOT NULL REFERENCES users (id),
  thread_id  TEXT,
  comment_id TEXT,
  text       TEXT,
  emoji      TEXT,
  role       TEXT,
  count      INTEGER NOT NULL DEFAULT 1,
  -- requests: 'pending' until someone answers, then 'approved' / 'denied'
  state      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  read_at    INTEGER
);
CREATE INDEX notifications_user ON notifications (user_id, updated_at DESC);
CREATE INDEX notifications_file ON notifications (file_key);

-- Settings › Notifications: the person's choices (JSON, src/shared/notifications.ts NotificationPrefs).
CREATE TABLE notification_prefs (
  user_id    TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  prefs      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
