-- Governance+ (docs/governance.md). Times are ms since the epoch.
ALTER TABLE orgs ADD COLUMN governance_plus INTEGER NOT NULL DEFAULT 0;

-- Multiple IdPs (§2.9): idp_configs keyed by tenant_id
PRAGMA defer_foreign_keys = true;
CREATE TABLE idp_configs_new (
  tenant_id     TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  name          TEXT NOT NULL DEFAULT '',
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
INSERT INTO idp_configs_new (tenant_id, org_id, provider, idp_entity_id, sso_url, certificates, metadata_url, signing, tested_at, created_by, created_at, updated_at)
  SELECT tenant_id, org_id, provider, idp_entity_id, sso_url, certificates, metadata_url, signing, tested_at, created_by, created_at, updated_at FROM idp_configs;
DROP TABLE idp_configs;
ALTER TABLE idp_configs_new RENAME TO idp_configs;
CREATE INDEX idp_configs_org ON idp_configs (org_id, created_at);
CREATE UNIQUE INDEX idp_configs_entity ON idp_configs (org_id, idp_entity_id);
ALTER TABLE org_domains ADD COLUMN idp_tenant_id TEXT;
ALTER TABLE scim_tokens ADD COLUMN tenant_id TEXT;
UPDATE scim_tokens SET tenant_id = (SELECT tenant_id FROM idp_configs i WHERE i.org_id = scim_tokens.org_id);

-- Two-factor authentication (§2.4). secret: sealed base64 under a key derived from SESSION_SECRET.
CREATE TABLE user_two_factor (
  user_id            TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  secret             TEXT NOT NULL,
  enabled_at         INTEGER,
  pending_expires_at INTEGER,
  last_step          INTEGER NOT NULL DEFAULT 0,
  failed_count       INTEGER NOT NULL DEFAULT 0,
  failed_since       INTEGER,
  created_at         INTEGER NOT NULL
);
CREATE TABLE user_recovery_codes (
  user_id   TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at   INTEGER,
  PRIMARY KEY (user_id, code_hash)
);
ALTER TABLE auth_codes ADD COLUMN mfa_pending INTEGER NOT NULL DEFAULT 0;

-- Guest expiration (§2.13)
ALTER TABLE org_members ADD COLUMN expires_at INTEGER;
CREATE INDEX org_members_expiry ON org_members (expires_at) WHERE expires_at IS NOT NULL;

-- IP allowlist and network access restrictions (§2.3, §2.2)
CREATE TABLE org_ip_ranges (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('allowlist', 'network')),
  cidr       TEXT NOT NULL,
  state      TEXT NOT NULL DEFAULT 'enforced' CHECK (state IN ('testing', 'enforced', 'disabled')),
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX org_ip_ranges_cidr ON org_ip_ranges (org_id, kind, cidr);
CREATE INDEX org_ip_ranges_kind ON org_ip_ranges (kind, state);
CREATE TABLE network_shadow_hits (
  range_id TEXT NOT NULL REFERENCES org_ip_ranges (id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL,
  day      INTEGER NOT NULL,
  PRIMARY KEY (range_id, user_id, day)
);

-- Internal policies (§2.6)
CREATE TABLE org_policies (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  text        TEXT NOT NULL,
  audience    TEXT NOT NULL CHECK (audience IN ('members', 'guests', 'everyone')),
  cadence     TEXT NOT NULL CHECK (cadence IN ('yearly', 'once')),
  enabled_at  INTEGER,
  disabled_at INTEGER,
  created_by  TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX org_policies_org ON org_policies (org_id, enabled_at);
CREATE TABLE policy_acknowledgements (
  policy_id TEXT NOT NULL REFERENCES org_policies (id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  at        INTEGER NOT NULL,
  PRIMARY KEY (policy_id, user_id)
);

-- Encryption key management (§2.10): managed keys only (the org's DEK wrapped under the Worker secret EKM_ROOT_KEY)
CREATE TABLE org_keys (
  org_id      TEXT PRIMARY KEY REFERENCES orgs (id) ON DELETE CASCADE,
  source      TEXT NOT NULL DEFAULT 'managed' CHECK (source IN ('managed')),
  wrapped_dek TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'ok' CHECK (state IN ('ok', 'unavailable')),
  checked_at  INTEGER,
  created_by  TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
ALTER TABLE files ADD COLUMN encrypted_at INTEGER;

-- Discovery (§2.11): Figma's fields; hour = floor(timestamp / 3600)
CREATE TABLE discovery_events (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id                   TEXT NOT NULL,
  hour                     INTEGER NOT NULL,
  file_key                 TEXT NOT NULL,
  text                     TEXT NOT NULL,
  timestamp                INTEGER NOT NULL,
  action_type              TEXT NOT NULL CHECK (action_type IN ('insert', 'update', 'delete', 'transient')),
  file_name                TEXT NOT NULL,
  file_workspace_id        TEXT,
  node_id                  TEXT,
  text_type                TEXT NOT NULL,
  resource_id              TEXT,
  parent_comment_id        TEXT,
  user_id                  TEXT NOT NULL,
  user_email               TEXT NOT NULL,
  user_billing_group_id    TEXT,
  feature_entrypoint       TEXT,
  moderation_failure_flags TEXT
);
CREATE INDEX discovery_events_hour ON discovery_events (org_id, hour, id);
CREATE INDEX discovery_events_age ON discovery_events (timestamp);

-- Developer logs (§2.12)
CREATE TABLE developer_logs (
  uuid           TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  at             INTEGER NOT NULL,
  event_name     TEXT NOT NULL,
  event_source   TEXT NOT NULL CHECK (event_source IN ('rest_api', 'mcp_server')),
  user_id        TEXT,
  user_name      TEXT,
  user_email     TEXT,
  token_id       TEXT,
  token_name     TEXT,
  token_type     TEXT NOT NULL,
  resource_type  TEXT,
  resource_id    TEXT,
  resource_name  TEXT,
  ip_address     TEXT NOT NULL,
  city           TEXT,
  country_region TEXT,
  country        TEXT
);
CREATE INDEX developer_logs_org ON developer_logs (org_id, at);
