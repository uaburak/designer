-- Delete organization (docs/multiplayer.md §14.17): Admin › Settings › Delete organization. An org admin types the
-- organization's name; the org is soft-deleted — hidden from its members and guests, its files closed to everyone but
-- its admins (read-only), restorable by an admin — until `purge_at` (14 days later, ours), when the daily cron deletes
-- it for good: its files (rooms, comments, stored bytes), libraries, fonts and icons, then the org row (cascading to
-- its teams, folders, people, settings and log).
ALTER TABLE orgs ADD COLUMN deleted_at INTEGER;
ALTER TABLE orgs ADD COLUMN deleted_by TEXT;
ALTER TABLE orgs ADD COLUMN purge_at INTEGER;
CREATE INDEX orgs_purge ON orgs (purge_at) WHERE purge_at IS NOT NULL;
