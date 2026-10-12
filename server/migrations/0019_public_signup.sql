-- Public sign-up (docs/multiplayer.md §17): suspension and per-account quota overrides, stored bytes tracked as they
-- are uploaded, counters for daily and per-minute quotas, the operator's server-wide settings and the sign-up allowlist.

-- Suspended by the operator: every route answers 403 account_suspended; null = active
ALTER TABLE users ADD COLUMN suspended_at INTEGER;
ALTER TABLE users ADD COLUMN suspended_reason TEXT;
-- The operator's per-account overrides, JSON {kind: limit} (src/shared/quota.ts AccountQuotaKind)
ALTER TABLE users ADD COLUMN quota_overrides TEXT NOT NULL DEFAULT '{}';
-- The bytes the account's files and previews keep on the server: the sum of its stored_items, moved with each upload
ALTER TABLE users ADD COLUMN stored_bytes INTEGER NOT NULL DEFAULT 0;

-- What each uploaded thing weighs and whom it is charged to. `item` names it: f:<fileKey>:snap · f:<fileKey>:thumb ·
-- f:<fileKey>:b:<sha1> · p:<previewId>:doc · p:<previewId>:i:<sha1> · l:<libraryKey>:p:<asset>:<hash> ·
-- l:<libraryKey>:b:<sha1> · o:<orgId>:font:<sha1>. Released by prefix when the file, preview or library goes.
CREATE TABLE stored_items (
  item     TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  bytes    INTEGER NOT NULL
);
CREATE INDEX stored_items_owner ON stored_items (owner_id);

-- Counters of daily and per-minute quotas: subject (a user id, `ip:<address>`, `*` for the server), kind, window
-- (the day or minute number; 0 for running totals such as the server's stored bytes). Old windows swept daily.
CREATE TABLE quota_counters (
  subject TEXT NOT NULL,
  kind    TEXT NOT NULL,
  window  INTEGER NOT NULL,
  n       INTEGER NOT NULL,
  PRIMARY KEY (subject, kind, window)
);

-- The operator's server-wide settings: signup_mode = open | invite | closed
CREATE TABLE server_settings (
  k          TEXT PRIMARY KEY,
  v          TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

-- Emails allowed to create an account while sign-up is `invite`
CREATE TABLE signup_allowlist (
  email      TEXT PRIMARY KEY,
  added_by   TEXT,
  created_at INTEGER NOT NULL
);
