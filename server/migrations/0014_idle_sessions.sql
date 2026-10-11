-- Sessions ended by the idle timeout (docs/multiplayer.md §15.8): a socket upgrade can be the first request to find a
-- session idle, and a WebSocket shows no status — so the session's id is kept here, and later calls with its token are
-- told `401 idle_timeout` (not a plain 401) and the app says why it signed out. Rows older than a session token's
-- lifetime (30 days) are dropped as new ones are written.
CREATE TABLE idle_ended_sessions (
  id       TEXT PRIMARY KEY,
  user_id  TEXT NOT NULL,
  ended_at INTEGER NOT NULL
);
CREATE INDEX idle_ended_sessions_age ON idle_ended_sessions (ended_at);
