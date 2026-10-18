-- Data storage localization's moves (docs/multiplayer.md §15.16; leftovers 2026-10-18). One move at a time per org:
-- `POST admin/data-region/move` takes `region_move_until` in one UPDATE … RETURNING (a lease, as webhooks'
-- `sending_until`) — two at once could copy one object twice, and the one that failed then deleted the copy the other
-- had already made live. The old objects a move couldn't delete are kept in `region_leftovers` until the daily cron
-- deletes them (their content would otherwise stay at rest in the region the org left).
ALTER TABLE orgs ADD COLUMN region_move_until INTEGER;

CREATE TABLE region_leftovers (
  kind TEXT NOT NULL CHECK (kind IN ('room', 'library')),
  -- The file's or library's key (the object's name)
  name TEXT NOT NULL,
  -- The old object's jurisdiction: 'default' or 'eu'
  jurisdiction TEXT NOT NULL,
  org_id TEXT,
  at INTEGER NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, name, jurisdiction)
);
