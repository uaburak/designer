-- Device ordinals (docs/multiplayer.md §2.1): each installation that signs in gets one, unique on the server, so the
-- GUIDs its sessions mint ((ordinal << 20) | n, src/shared/schema/guid.ts) never meet another installation's.
-- 1 stays the unsynced default; ordinals start at 2 and stop at 4095.
CREATE TABLE devices (
  ordinal         INTEGER PRIMARY KEY,
  installation_id TEXT NOT NULL UNIQUE,
  user_id         TEXT NOT NULL REFERENCES users (id),
  created_at      INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL
);
