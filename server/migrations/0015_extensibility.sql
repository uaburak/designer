-- Extensibility and Dev Mode (docs/multiplayer.md §16, docs/plugins.md, docs/editor.md "Dev Mode — round 5"): the REST
-- API's plan tokens and rate counters, webhooks, dev resources, Code Connect, Dev Mode viewers, prototype-only
-- members, private plugins and approvals, the AI usage table round 6 fills. Times are ms since the epoch.

-- Plan access tokens (§16.3) are access_tokens rows of kind 'plan' for one org; user_id = the admin who made it.
ALTER TABLE access_tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'personal' CHECK (kind IN ('personal', 'plan'));
ALTER TABLE access_tokens ADD COLUMN org_id TEXT REFERENCES orgs (id) ON DELETE CASCADE;
CREATE INDEX access_tokens_org ON access_tokens (org_id) WHERE org_id IS NOT NULL;

-- REST rate counters (§16.4): subject = user id or 'org:<id>'; bucket t1 | t2 | t3 | t1day | day; window = minute
-- number or UTC day number.
CREATE TABLE rest_rate (
  subject TEXT NOT NULL,
  bucket  TEXT NOT NULL,
  window  INTEGER NOT NULL,
  count   INTEGER NOT NULL,
  PRIMARY KEY (subject, bucket, window)
);

-- Webhooks V2 (§16.9). Ids are numbers, as Figma's. context_id: team, folder (project) or file key.
CREATE TABLE webhooks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type  TEXT NOT NULL CHECK (event_type IN ('FILE_UPDATE', 'FILE_VERSION_UPDATE', 'FILE_DELETE', 'LIBRARY_PUBLISH', 'FILE_COMMENT', 'DEV_MODE_STATUS_UPDATE')),
  context     TEXT NOT NULL CHECK (context IN ('team', 'project', 'file')),
  context_id  TEXT NOT NULL,
  org_id      TEXT REFERENCES orgs (id) ON DELETE CASCADE,
  team_id     TEXT,
  endpoint    TEXT NOT NULL,
  passcode    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED')),
  description TEXT,
  created_by  TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX webhooks_context ON webhooks (context, context_id, event_type);
CREATE INDEX webhooks_org ON webhooks (org_id);

-- One row per delivery (the log of GET /v2/webhooks/:id/requests and the retry queue). next_at null: done.
CREATE TABLE webhook_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id  INTEGER NOT NULL REFERENCES webhooks (id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL,
  payload     TEXT NOT NULL,
  sent_at     INTEGER,
  attempt     INTEGER NOT NULL DEFAULT 0,
  status      INTEGER,
  received_at INTEGER,
  error_msg   TEXT,
  next_at     INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX webhook_requests_due ON webhook_requests (next_at) WHERE next_at IS NOT NULL;
CREATE INDEX webhook_requests_hook ON webhook_requests (webhook_id, created_at);

-- Dev resources (docs/editor.md D-3): links on a node of a shared file; ≤ 10 per node, a URL once per node.
CREATE TABLE dev_resources (
  id         TEXT PRIMARY KEY,
  file_key   TEXT NOT NULL REFERENCES files (key) ON DELETE CASCADE,
  node_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  url        TEXT NOT NULL,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (file_key, node_id, url)
);
CREATE INDEX dev_resources_node ON dev_resources (file_key, node_id);

-- Code Connect (docs/editor.md D-1): one mapping per (library file, main component or set node, label). template:
-- the template file's JavaScript (CLI), null for a Code Connect UI mapping (source + component only).
CREATE TABLE code_connect (
  file_key     TEXT NOT NULL REFERENCES files (key) ON DELETE CASCADE,
  node_id      TEXT NOT NULL,
  label        TEXT NOT NULL,
  language     TEXT NOT NULL,
  origin       TEXT NOT NULL CHECK (origin IN ('cli', 'ui')),
  source       TEXT,
  component    TEXT,
  template     TEXT,
  imports      TEXT NOT NULL DEFAULT '[]',
  nestable     INTEGER NOT NULL DEFAULT 1,
  instructions TEXT NOT NULL DEFAULT '',
  updated_by   TEXT REFERENCES users (id) ON DELETE SET NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (file_key, node_id, label)
);

-- Who viewed a file in Dev Mode (notified of status changes, docs/editor.md D-4) and their choice: 1 "Status
-- changes", 0 "Nothing".
CREATE TABLE dev_mode_viewers (
  file_key  TEXT NOT NULL REFERENCES files (key) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  viewed_at INTEGER NOT NULL,
  notify    INTEGER NOT NULL DEFAULT 1 CHECK (notify IN (0, 1)),
  PRIMARY KEY (file_key, user_id)
);
CREATE INDEX dev_mode_viewers_user ON dev_mode_viewers (user_id);

-- Prototype-only access (docs/editor.md D-6): people invited from "Share prototype", and the org audience of the
-- prototype link (files.proto_link_access, 0010, stays "Anyone").
CREATE TABLE prototype_members (
  file_key   TEXT NOT NULL REFERENCES files (key) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  user_id    TEXT REFERENCES users (id) ON DELETE CASCADE,
  invited_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (file_key, email)
);
CREATE INDEX prototype_members_user ON prototype_members (user_id);
ALTER TABLE files ADD COLUMN proto_org_link_access TEXT NOT NULL DEFAULT 'none' CHECK (proto_org_link_access IN ('none', 'viewer'));

-- Library items for the REST API (§16.7, §16.10): the asset's node in the library file and its dates.
ALTER TABLE library_assets ADD COLUMN node_id TEXT;
ALTER TABLE library_assets ADD COLUMN created_at INTEGER;
ALTER TABLE library_assets ADD COLUMN updated_at INTEGER;
ALTER TABLE library_assets ADD COLUMN created_by TEXT;

-- Private plugins and widgets of an org (docs/plugins.md §10). id: a 19-digit decimal string, as Figma's plugin ids.
CREATE TABLE plugins (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('plugin', 'widget')),
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  -- the manifest as published (docs/plugins.md §4), with id set to this row's id
  manifest     TEXT NOT NULL,
  version      INTEGER NOT NULL,
  -- {sha1, size} per part: code, ui[:key]
  parts        TEXT NOT NULL,
  published_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER
);
CREATE INDEX plugins_org ON plugins (org_id, kind) WHERE deleted_at IS NULL;

-- Plugin code and UI in ≤ 1 MB chunks (no Durable Object: a few MB per plugin).
CREATE TABLE plugin_chunks (
  plugin_id TEXT NOT NULL REFERENCES plugins (id) ON DELETE CASCADE,
  version   INTEGER NOT NULL,
  part      TEXT NOT NULL,
  idx       INTEGER NOT NULL,
  bytes     BLOB NOT NULL,
  PRIMARY KEY (plugin_id, version, part, idx)
);

-- Admin-approved plugins and widgets (docs/plugins.md §10.2). plugin_id: any manifest id (not only private ones).
CREATE TABLE plugin_approvals (
  org_id     TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  plugin_id  TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('plugin', 'widget')),
  name       TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('org', 'workspace')),
  scope_id   TEXT NOT NULL,
  added_by   TEXT REFERENCES users (id) ON DELETE SET NULL,
  added_at   INTEGER NOT NULL,
  PRIMARY KEY (org_id, plugin_id, scope_type, scope_id)
);

CREATE TABLE plugin_requests (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  plugin_id      TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('plugin', 'widget')),
  name           TEXT NOT NULL,
  -- the manifest the requester has (development / imported plugins), so admins see what it asks for
  manifest       TEXT NOT NULL DEFAULT '{}',
  requested_by   TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  workspace_id   TEXT,
  reason         TEXT NOT NULL DEFAULT '',
  state          TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'declined')),
  decline_reason TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  answered_at    INTEGER,
  answered_by    TEXT REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX plugin_requests_org ON plugin_requests (org_id, state);

-- AI usage per person and day (§16.7 GET /v1/ai_usage/daily), filled by round 6's usage meter.
CREATE TABLE ai_usage_daily (
  org_id           TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL,
  day              TEXT NOT NULL,
  editor_type      TEXT NOT NULL,
  seat_credits     REAL NOT NULL DEFAULT 0,
  plan_credits     REAL NOT NULL DEFAULT 0,
  workspace_id     TEXT,
  team_id          TEXT,
  billing_group_id TEXT,
  PRIMARY KEY (org_id, user_id, day, editor_type)
);
