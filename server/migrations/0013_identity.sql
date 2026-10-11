-- Identity and security (docs/multiplayer.md §15): SAML SSO per org, SCIM, domains, sessions' auth method and idle
-- timeout, data storage localization. Times are ms since the epoch.

-- One SAML configuration per org (§15.3.1). certificates: JSON array of PEM strings (≤ 2).
CREATE TABLE idp_configs (
  org_id        TEXT PRIMARY KEY REFERENCES orgs (id) ON DELETE CASCADE,
  tenant_id     TEXT NOT NULL UNIQUE,
  provider      TEXT NOT NULL CHECK (provider IN ('okta', 'entra', 'onelogin', 'google', 'custom')),
  idp_entity_id TEXT NOT NULL,
  sso_url       TEXT NOT NULL,
  certificates  TEXT NOT NULL,
  metadata_url  TEXT,
  signing       TEXT NOT NULL DEFAULT 'assertion' CHECK (signing IN ('assertion', 'assertion_or_response')),
  tested_at     INTEGER,
  created_by    TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- AuthnRequests waiting for their Response (§15.3.3): consumed once with DELETE … RETURNING. state: the app's
-- {p | r, s, c} (the signed oauthState's payload) as JSON.
CREATE TABLE saml_requests (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  state      TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX saml_requests_expiry ON saml_requests (expires_at);

-- Accepted assertion IDs until their NotOnOrAfter: a second INSERT of one is a replay (§15.3.4 step 5).
CREATE TABLE saml_assertions (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX saml_assertions_expiry ON saml_assertions (expires_at);

-- The sign-in code knows how it was earned, so /auth/token makes the right session.
ALTER TABLE auth_codes ADD COLUMN auth TEXT NOT NULL DEFAULT 'google' CHECK (auth IN ('google', 'saml', 'dev'));
ALTER TABLE auth_codes ADD COLUMN org_id TEXT;

-- One live SCIM token per org (§15.5): only its SHA-256.
CREATE TABLE scim_tokens (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  created_by   TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX scim_tokens_org ON scim_tokens (org_id, revoked_at);

-- People the IdP manages in an org (SCIM's Users). active 0: deactivated (removed from the org, the link kept).
CREATE TABLE scim_users (
  org_id      TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  user_name   TEXT NOT NULL,
  external_id TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  -- the seat SCIM last set ('full' | 'dev' | 'collab' | 'view'), restored on reactivation
  seat        TEXT CHECK (seat IN ('full', 'dev', 'collab', 'view')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE UNIQUE INDEX scim_users_name ON scim_users (org_id, user_name);
CREATE UNIQUE INDEX scim_users_external ON scim_users (org_id, external_id) WHERE external_id IS NOT NULL;

-- SCIM's Groups and what each is linked to by its name (§15.5).
CREATE TABLE scim_groups (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  external_id  TEXT,
  target_type  TEXT NOT NULL CHECK (target_type IN ('workspace', 'billing_group', 'user_group')),
  target_id    TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX scim_groups_org ON scim_groups (org_id, display_name);
CREATE UNIQUE INDEX scim_groups_external ON scim_groups (org_id, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE scim_group_members (
  group_id TEXT NOT NULL REFERENCES scim_groups (id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX scim_group_members_user ON scim_group_members (user_id);

-- What SAML JIT and SCIM told us about a member (IdpAttributes JSON) and who provisioned them.
ALTER TABLE org_members ADD COLUMN idp_attributes TEXT NOT NULL DEFAULT '{}';
ALTER TABLE org_members ADD COLUMN provisioned_by TEXT CHECK (provisioned_by IN ('scim', 'jit'));

-- An org's email domains (§15.7). A verified domain belongs to one org.
CREATE TABLE org_domains (
  org_id      TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  domain      TEXT NOT NULL,
  token       TEXT NOT NULL,
  created_by  TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  verified_at INTEGER,
  PRIMARY KEY (org_id, domain)
);
CREATE UNIQUE INDEX org_domains_verified ON org_domains (domain) WHERE verified_at IS NOT NULL;
CREATE INDEX org_domains_domain ON org_domains (domain);

-- Sessions: how they were signed in, the last user activity and the idle limit (§15.8).
ALTER TABLE sessions ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'google' CHECK (auth_method IN ('google', 'saml', 'dev'));
ALTER TABLE sessions ADD COLUMN auth_org_id TEXT;
ALTER TABLE sessions ADD COLUMN active_at INTEGER;
ALTER TABLE sessions ADD COLUMN idle_limit_ms INTEGER;
UPDATE sessions SET active_at = last_seen_at;

-- Data storage localization (§15.10): the org's region; the jurisdiction each room or library object lives in.
ALTER TABLE orgs ADD COLUMN data_region TEXT NOT NULL DEFAULT 'default' CHECK (data_region IN ('default', 'eu'));
ALTER TABLE files ADD COLUMN jurisdiction TEXT CHECK (jurisdiction IN ('eu'));
ALTER TABLE libraries ADD COLUMN jurisdiction TEXT CHECK (jurisdiction IN ('eu'));
