-- Removing someone's access to one file of their team (the owner's Home, 2026-10-14): a team member reaches every file
-- in the team by default; a row here takes that inherited access away for this file only. What the person has on the
-- file itself (owner, a direct invite) and an org admin's reach stay (src/shared/org/access.ts, `excluded`).
CREATE TABLE file_exclusions (
  file_key TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (file_key, user_id)
);
CREATE INDEX file_exclusions_user ON file_exclusions (user_id);
