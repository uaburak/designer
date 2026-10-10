-- Developer previews (docs/multiplayer.md §9): who owns each preview id, for the owner's list and the owner-only
-- writes. The package itself (manifest, doc.kiwi, images) lives in the preview's own Durable Object (PreviewObject).
CREATE TABLE previews (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  file_key     TEXT,
  file_name    TEXT NOT NULL DEFAULT 'Untitled',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  -- null until the first manifest made it live
  published_at INTEGER,
  -- null: never expires
  expires_at   INTEGER
);
CREATE INDEX previews_owner ON previews (owner_id, updated_at);
