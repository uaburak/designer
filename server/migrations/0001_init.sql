-- Accounts, shared files and their members (docs/multiplayer.md §3). Emails are stored lowercased.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  google_sub    TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL,
  name          TEXT,
  picture       TEXT,
  token_version INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);
CREATE INDEX users_email ON users (email);

-- The owner is files.owner_id; members holds everyone else ("can edit" / "can view"), pending ones without user_id.
CREATE TABLE files (
  key        TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL REFERENCES users (id),
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX files_owner ON files (owner_id);

CREATE TABLE members (
  file_key   TEXT NOT NULL REFERENCES files (key) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  user_id    TEXT REFERENCES users (id),
  role       TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  invited_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (file_key, email)
);
CREATE INDEX members_user ON members (user_id);
CREATE INDEX members_email ON members (email);

-- One-time sign-in codes handed to the desktop app's loopback (stored hashed, bound to its PKCE challenge).
CREATE TABLE auth_codes (
  code_hash  TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id),
  challenge  TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
