-- Personal Drafts on the server (docs/cloud.md §2, Wecra 1.1): every account's Drafts live in the cloud, as Figma's.
-- `files.space = 'personal'` marks a file in its owner's Drafts (`org_id` NULL); NULL elsewhere — an org's files, branches.
-- Drafts are flat (no folders). Trashed drafts (`trashed_at`) are deleted for good by the daily cron after 30 days.
-- Every file outside an organization today is its owner's (shared from their local Drafts by 1.0.x): it becomes a draft.
ALTER TABLE files ADD COLUMN space TEXT CHECK (space IN ('personal'));
UPDATE files SET space = 'personal' WHERE org_id IS NULL AND key NOT IN (SELECT key FROM branches);
CREATE INDEX files_personal ON files (owner_id, trashed_at) WHERE space = 'personal';
CREATE INDEX files_personal_purge ON files (trashed_at) WHERE space = 'personal' AND trashed_at IS NOT NULL;
