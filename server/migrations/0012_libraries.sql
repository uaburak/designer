-- Libraries in organizations (docs/data.md §16), library analytics (§17), shared fonts (docs/desktop.md §14.3).
-- Times are ms since the epoch; days are 'YYYY-MM-DD' in UTC.

-- One row per org library: its file's room key. No foreign key to files: a library whose file was deleted forever
-- keeps its row (status 'deleted') so consumers can say "Missing library" (§9.6).
CREATE TABLE libraries (
  key               TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  -- the file's name at the last publish or rename (the live name is files.name while the file exists)
  name              TEXT NOT NULL,
  scope             TEXT NOT NULL DEFAULT 'team' CHECK (scope IN ('team', 'org')),
  status            TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'unpublished', 'trashed', 'deleted')),
  latest_version    INTEGER NOT NULL,
  -- {components, styles, variables} of the latest version's listed assets
  counts            TEXT NOT NULL DEFAULT '{}',
  first_published_at INTEGER NOT NULL,
  last_published_at INTEGER NOT NULL,
  published_by      TEXT REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX libraries_org ON libraries (org_id, status);

CREATE TABLE library_versions (
  library_key  TEXT NOT NULL REFERENCES libraries (key) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  -- counts of the version's created / modified / removed / moved (the manifest itself is in LibraryObject)
  changes      TEXT NOT NULL DEFAULT '{}',
  published_at INTEGER NOT NULL,
  published_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  PRIMARY KEY (library_key, version)
);

-- The latest manifest's assets, for names and counts in analytics and Admin. removed_in: the version that removed it.
CREATE TABLE library_assets (
  library_key       TEXT NOT NULL REFERENCES libraries (key) ON DELETE CASCADE,
  key               TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('COMPONENT', 'COMPONENT_SET', 'STYLE', 'VARIABLE_COLLECTION', 'VARIABLE')),
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  style_type        TEXT,
  resolved_type     TEXT,
  component_set_key TEXT,
  collection_key    TEXT,
  -- VARIABLE_COLLECTION only: [{id, name}] in order (default modes, the Modes tab)
  modes             TEXT,
  version_hash      TEXT NOT NULL,
  dependency_only   INTEGER NOT NULL DEFAULT 0,
  thumbnail_sha1    TEXT,
  removed_in        INTEGER,
  PRIMARY KEY (library_key, key)
);
CREATE INDEX library_assets_kind ON library_assets (library_key, kind);

-- Move to this file (§9.5) across org libraries
CREATE TABLE library_redirects (
  from_library TEXT NOT NULL,
  from_key     TEXT NOT NULL,
  to_library   TEXT NOT NULL REFERENCES libraries (key) ON DELETE CASCADE,
  to_key       TEXT NOT NULL,
  version      INTEGER NOT NULL,
  at           INTEGER NOT NULL,
  PRIMARY KEY (from_library, from_key)
);
CREATE INDEX library_redirects_to ON library_redirects (to_library);

-- Approved / enabled by default / default modes, per (library, org | workspace | team). Defaults: 1 on, 0 off (an
-- override of a higher level), NULL inherit.
CREATE TABLE library_settings (
  library_key    TEXT NOT NULL REFERENCES libraries (key) ON DELETE CASCADE,
  scope_type     TEXT NOT NULL CHECK (scope_type IN ('org', 'workspace', 'team')),
  scope_id       TEXT NOT NULL,
  approved       INTEGER NOT NULL DEFAULT 0,
  default_design INTEGER CHECK (default_design IN (0, 1)),
  default_figjam INTEGER CHECK (default_figjam IN (0, 1)),
  default_slides INTEGER CHECK (default_slides IN (0, 1)),
  default_buzz   INTEGER CHECK (default_buzz IN (0, 1)),
  -- [{collectionKey, modeId}] (workspace and team rows)
  default_modes  TEXT NOT NULL DEFAULT '[]',
  updated_by     TEXT REFERENCES users (id) ON DELETE SET NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (library_key, scope_type, scope_id)
);
CREATE INDEX library_settings_scope ON library_settings (scope_type, scope_id);

-- A file's explicit choice for a library ("Add to file" / "Remove from file"); no row: the defaults decide (§16.5).
CREATE TABLE library_subscriptions (
  file_key    TEXT NOT NULL REFERENCES files (key) ON DELETE CASCADE,
  library_key TEXT NOT NULL REFERENCES libraries (key) ON DELETE CASCADE,
  enabled     INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  changed_by  TEXT REFERENCES users (id) ON DELETE SET NULL,
  changed_at  INTEGER NOT NULL,
  PRIMARY KEY (file_key, library_key)
);
CREATE INDEX library_subscriptions_library ON library_subscriptions (library_key);

-- §17: insertions and detachments, pre-aggregated by the clients per (day, file, asset, action). team_id and
-- workspace_id are the file's at ingestion (a later move doesn't rewrite history).
CREATE TABLE library_actions_daily (
  day          TEXT NOT NULL,
  library_key  TEXT NOT NULL REFERENCES libraries (key) ON DELETE CASCADE,
  asset_key    TEXT NOT NULL,
  asset_type   TEXT NOT NULL CHECK (asset_type IN ('component', 'style', 'variable')),
  file_key     TEXT NOT NULL,
  team_id      TEXT,
  workspace_id TEXT,
  action       TEXT NOT NULL CHECK (action IN ('insert', 'detach')),
  count        INTEGER NOT NULL,
  PRIMARY KEY (library_key, day, asset_key, file_key, action)
);
CREATE INDEX library_actions_team ON library_actions_daily (library_key, team_id, day);

-- §17: the current instances of each library asset in each file (a snapshot the file's clients replace).
CREATE TABLE library_usage (
  file_key     TEXT NOT NULL REFERENCES files (key) ON DELETE CASCADE,
  library_key  TEXT NOT NULL REFERENCES libraries (key) ON DELETE CASCADE,
  asset_key    TEXT NOT NULL,
  asset_type   TEXT NOT NULL CHECK (asset_type IN ('component', 'style', 'variable', 'mode')),
  -- asset_type 'mode': asset_key is '<collectionKey>/<modeId>'
  instances    INTEGER NOT NULL,
  PRIMARY KEY (file_key, library_key, asset_key)
);
CREATE INDEX library_usage_library ON library_usage (library_key, asset_key);

-- The hash of each file's last accepted snapshot (an unchanged upload is a no-op)
CREATE TABLE library_usage_files (
  file_key    TEXT PRIMARY KEY REFERENCES files (key) ON DELETE CASCADE,
  hash        TEXT NOT NULL,
  reported_at INTEGER NOT NULL
);

-- §17.5: the daily roll-up (Cron Trigger) — what the analytics views read.
CREATE TABLE library_asset_stats (
  library_key  TEXT NOT NULL REFERENCES libraries (key) ON DELETE CASCADE,
  asset_key    TEXT NOT NULL,
  asset_type   TEXT NOT NULL,
  instances    INTEGER NOT NULL DEFAULT 0,
  files_using  INTEGER NOT NULL DEFAULT 0,
  teams_using  INTEGER NOT NULL DEFAULT 0,
  inserts_30d  INTEGER NOT NULL DEFAULT 0,
  detaches_30d INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (library_key, asset_key)
);
CREATE TABLE library_stats (
  library_key         TEXT PRIMARY KEY REFERENCES libraries (key) ON DELETE CASCADE,
  teams_using         INTEGER NOT NULL DEFAULT 0,
  inserts_last_week   INTEGER NOT NULL DEFAULT 0,
  inserts_this_week   INTEGER NOT NULL DEFAULT 0,
  detaches_this_week  INTEGER NOT NULL DEFAULT 0,
  -- the last whole day included ('YYYY-MM-DD'): "updated daily"
  through_day         TEXT NOT NULL
);

-- docs/desktop.md §14.3: shared fonts (org or team), one row per face; the bytes are in the org's FontObject.
CREATE TABLE shared_fonts (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  -- null: an organization font; else a team font
  team_id         TEXT REFERENCES teams (id) ON DELETE CASCADE,
  family          TEXT NOT NULL,
  style           TEXT NOT NULL,
  postscript_name TEXT NOT NULL,
  weight          INTEGER NOT NULL,
  italic          INTEGER NOT NULL DEFAULT 0,
  stretch         INTEGER NOT NULL DEFAULT 5,
  variable        INTEGER NOT NULL DEFAULT 0,
  sha1            TEXT NOT NULL,
  format          TEXT NOT NULL CHECK (format IN ('ttf', 'otf')),
  size            INTEGER NOT NULL,
  file_name       TEXT NOT NULL,
  uploaded_by     TEXT REFERENCES users (id) ON DELETE SET NULL,
  uploaded_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX shared_fonts_face ON shared_fonts (org_id, COALESCE(team_id, ''), family, style);
CREATE INDEX shared_fonts_sha1 ON shared_fonts (org_id, sha1);
