-- Settings (docs/multiplayer.md §13): sessions, personal access tokens and the account's own settings.

-- One row per sign-in: Settings › Security › Sessions. A session token carries its row's id (`sid`); "Sign out" on a
-- row deletes it and that token stops working at once. Sign out everywhere (token version) still ends them all.
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- "app": the desktop app; "login": a browser
  kind         TEXT NOT NULL CHECK (kind IN ('app', 'login')),
  os           TEXT,
  browser      TEXT,
  ip           TEXT,
  city         TEXT,
  country      TEXT,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id, last_seen_at);

-- Personal access tokens ("Generate new token"): only the SHA-256 of the token is kept; scopes as a JSON array.
CREATE TABLE access_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  description  TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  scopes       TEXT NOT NULL DEFAULT '[]',
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER,
  last_used_at INTEGER
);
CREATE INDEX access_tokens_user ON access_tokens (user_id);

-- The account's own settings: a name or photo the user set (`name` / `picture`, then locked: Google's no longer
-- overwrites them at sign-in; an uploaded photo is a data: URL, ≤ 300 kB), the role ("Design", …), the Community
-- profile and the preferences kept with the account.
ALTER TABLE users ADD COLUMN name_locked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN picture_locked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN job_role TEXT;
ALTER TABLE users ADD COLUMN community TEXT NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN prefs TEXT NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX users_handle ON users (lower(json_extract(community, '$.handle'))) WHERE json_extract(community, '$.handle') IS NOT NULL;
