-- Organizations (docs/multiplayer.md §14): orgs → workspaces → teams → folders ("projects", Figma's API and log name)
-- → files; members, guests, seats, user groups, billing groups, the activity log. Times are ms since the epoch.

CREATE TABLE orgs (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  -- OrgSettings JSON (src/shared/org/types.ts): team creation, guests, links, seats, …
  settings   TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL REFERENCES users (id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE workspaces (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  hidden     INTEGER NOT NULL DEFAULT 0,
  -- per-workspace overrides of OrgSettings (round 4: sharing, export, AI)
  settings   TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX workspaces_org ON workspaces (org_id);

CREATE TABLE billing_groups (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX billing_groups_org ON billing_groups (org_id);

-- Everyone in an org. A row with no user_id is an invite to an email without an account yet (as members, 0001).
CREATE TABLE org_members (
  org_id           TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  email            TEXT NOT NULL,
  user_id          TEXT REFERENCES users (id) ON DELETE CASCADE,
  role             TEXT NOT NULL CHECK (role IN ('admin', 'member', 'guest')),
  seat             TEXT NOT NULL DEFAULT 'view' CHECK (seat IN ('full', 'dev', 'collab', 'view')),
  workspace_id     TEXT REFERENCES workspaces (id) ON DELETE SET NULL,
  billing_group_id TEXT REFERENCES billing_groups (id) ON DELETE SET NULL,
  invited_by       TEXT REFERENCES users (id),
  created_at       INTEGER NOT NULL,
  seat_changed_at  INTEGER,
  -- last request seen from this person in this org (Admin › People "Last active"; moved on at most every 5 minutes)
  last_active_at   INTEGER,
  PRIMARY KEY (org_id, email)
);
CREATE INDEX org_members_user ON org_members (user_id);
CREATE INDEX org_members_workspace ON org_members (org_id, workspace_id);

CREATE TABLE workspace_admins (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE billing_group_admins (
  billing_group_id TEXT NOT NULL REFERENCES billing_groups (id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  PRIMARY KEY (billing_group_id, user_id)
);

CREATE TABLE teams (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  workspace_id     TEXT REFERENCES workspaces (id) ON DELETE SET NULL,
  name             TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  -- a data: URL ≤ 100 kB, or null (the initial on a colour)
  icon             TEXT,
  owner_id         TEXT NOT NULL REFERENCES users (id),
  -- audience: "‹Organization›" / "‹Workspace›" and what they can do; visibility applies to "Only those invited"
  org_access       TEXT NOT NULL DEFAULT 'none' CHECK (org_access IN ('none', 'viewer', 'editor')),
  workspace_access TEXT NOT NULL DEFAULT 'none' CHECK (workspace_access IN ('none', 'viewer', 'editor')),
  visibility       TEXT NOT NULL DEFAULT 'visible' CHECK (visibility IN ('visible', 'hidden')),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  deleted_at       INTEGER,
  deleted_by       TEXT REFERENCES users (id)
);
CREATE INDEX teams_org ON teams (org_id, workspace_id);

CREATE TABLE workspace_default_teams (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  team_id      TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  PRIMARY KEY (workspace_id, team_id)
);

CREATE TABLE team_members (
  team_id    TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  user_id    TEXT REFERENCES users (id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  admin      INTEGER NOT NULL DEFAULT 0,
  invited_by TEXT REFERENCES users (id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, email)
);
CREATE INDEX team_members_user ON team_members (user_id);

-- "Request to join" a Visible team (org members only)
CREATE TABLE team_requests (
  team_id    TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);

-- Folders (Figma's "projects" until 2026-08-03; the API and the activity log keep "project").
CREATE TABLE projects (
  id         TEXT PRIMARY KEY,
  team_id    TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  parent_id  TEXT REFERENCES projects (id) ON DELETE CASCADE,
  depth      INTEGER NOT NULL DEFAULT 1 CHECK (depth BETWEEN 1 AND 10),
  name       TEXT NOT NULL,
  owner_id   TEXT NOT NULL REFERENCES users (id),
  access     TEXT NOT NULL DEFAULT 'inherited' CHECK (access IN ('inherited', 'limited')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  trashed_at INTEGER,
  trashed_by TEXT REFERENCES users (id)
);
CREATE INDEX projects_team ON projects (team_id, parent_id);

CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  user_id    TEXT REFERENCES users (id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  invited_by TEXT REFERENCES users (id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, email)
);
CREATE INDEX project_members_user ON project_members (user_id);

CREATE TABLE user_groups (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL REFERENCES users (id),
  -- set for groups synced from the IdP (round 4, SCIM): their membership is the IdP's
  external_id TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX user_groups_org ON user_groups (org_id);

CREATE TABLE user_group_members (
  group_id   TEXT NOT NULL REFERENCES user_groups (id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  added_by   TEXT REFERENCES users (id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX user_group_members_user ON user_group_members (user_id);

-- A user group invited to a team, folder or file ("Can edit" / "Can view").
CREATE TABLE group_grants (
  group_id      TEXT NOT NULL REFERENCES user_groups (id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('team', 'project', 'file')),
  resource_id   TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  granted_by    TEXT REFERENCES users (id),
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (group_id, resource_type, resource_id)
);
CREATE INDEX group_grants_resource ON group_grants (resource_type, resource_id);

-- "Ask to upgrade" a seat; answered by org, workspace or billing group admins (or automatically, OrgSettings.seatApproval)
CREATE TABLE seat_requests (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  seat        TEXT NOT NULL CHECK (seat IN ('full', 'dev', 'collab')),
  note        TEXT NOT NULL DEFAULT '',
  state       TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'denied')),
  answered_by TEXT REFERENCES users (id),
  created_at  INTEGER NOT NULL,
  answered_at INTEGER
);
CREATE INDEX seat_requests_org ON seat_requests (org_id, state, created_at);

-- Invites of outside emails waiting for an admin ("Require admin approval", round 4 enforces; round 1 stores)
CREATE TABLE guest_requests (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  invited_by    TEXT NOT NULL REFERENCES users (id),
  resource_type TEXT NOT NULL CHECK (resource_type IN ('team', 'project', 'file')),
  resource_id   TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  state         TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'denied')),
  answered_by   TEXT REFERENCES users (id),
  created_at    INTEGER NOT NULL,
  answered_at   INTEGER
);
CREATE INDEX guest_requests_org ON guest_requests (org_id, state);

-- Files join the hierarchy. org_id null: a file shared per file outside any org (§3, unchanged).
-- project_id null with org_id set: a draft of owner_id in that org. team_id is project_id's team, kept for queries.
ALTER TABLE files ADD COLUMN org_id TEXT REFERENCES orgs (id);
ALTER TABLE files ADD COLUMN team_id TEXT REFERENCES teams (id);
ALTER TABLE files ADD COLUMN project_id TEXT REFERENCES projects (id);
ALTER TABLE files ADD COLUMN editor_type TEXT NOT NULL DEFAULT 'design' CHECK (editor_type IN ('design', 'figjam', 'slides', 'buzz', 'sites', 'make'));
ALTER TABLE files ADD COLUMN access TEXT NOT NULL DEFAULT 'inherited' CHECK (access IN ('inherited', 'limited'));
-- "Anyone at ‹org› with the link" (members only); link_access (0003) stays "Anyone with the link"
ALTER TABLE files ADD COLUMN org_link_access TEXT NOT NULL DEFAULT 'none' CHECK (org_link_access IN ('none', 'viewer', 'editor'));
-- prototype-only links (round 5c); stored now so fig_file_proto_link_access_change has a column
ALTER TABLE files ADD COLUMN proto_link_access TEXT NOT NULL DEFAULT 'none' CHECK (proto_link_access IN ('none', 'viewer'));
-- "Require design-file links to expire" (R18 A-6): past it, link-only people are refused and the link reads as off
ALTER TABLE files ADD COLUMN link_expires_at INTEGER;
ALTER TABLE files ADD COLUMN trashed_at INTEGER;
ALTER TABLE files ADD COLUMN trashed_by TEXT REFERENCES users (id);
CREATE INDEX files_project ON files (project_id);
CREATE INDEX files_org_owner ON files (org_id, owner_id);

-- Notifications (§12) learn their org and team: the bell's "All notifications ⌄" can filter by them; new kinds in §14.11.
ALTER TABLE notifications ADD COLUMN org_id TEXT REFERENCES orgs (id) ON DELETE CASCADE;
ALTER TABLE notifications ADD COLUMN team_id TEXT REFERENCES teams (id) ON DELETE SET NULL;

-- The activity log (Admin › Activity; the REST /v1/activity_logs of round 5): Figma's event shape, one row per event.
CREATE TABLE activity_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id      TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  at          INTEGER NOT NULL,
  -- Figma's action.type, e.g. fig_file_view (§14.10)
  action      TEXT NOT NULL,
  -- null: anonymous (Figma: "The actor field can be empty if an anonymous request triggers the event")
  actor_id    TEXT,
  actor_email TEXT,
  actor_name  TEXT,
  -- file | file_repo | org | project | team | user | workspace | … (Figma's entity types) and the entity's fields
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  entity      TEXT NOT NULL DEFAULT '{}',
  -- action.details
  details     TEXT NOT NULL DEFAULT '{}',
  team_id     TEXT,
  ip          TEXT,
  -- context.client_name: "DesignerV2-Desktop/<v>" or the browser
  client_name TEXT
);
CREATE INDEX activity_org_at ON activity_log (org_id, at);
CREATE INDEX activity_org_action ON activity_log (org_id, action, at);
CREATE INDEX activity_org_actor ON activity_log (org_id, actor_id, at);
CREATE INDEX activity_org_team ON activity_log (org_id, team_id, at);
