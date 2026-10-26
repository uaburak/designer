-- Invitations wait for an answer (the owner's call, 2026-10-26): someone added in Admin › People or invited to a team
-- gets a row with `invite_pending = 1` and no `user_id` — no access, not listed in their spaces — and a bell row with
-- Accept / Decline (docs/multiplayer.md §14.18). Accepting sets `user_id` and clears the flag; declining deletes the row.
ALTER TABLE org_members ADD COLUMN invite_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE team_members ADD COLUMN invite_pending INTEGER NOT NULL DEFAULT 0;
