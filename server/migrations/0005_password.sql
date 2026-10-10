-- "Password required" for people who reach a file by its link (docs/multiplayer.md §3). Invited people don't need it.
-- The hash is "pbkdf2-sha256$<iterations>$<salt b64url>$<hash b64url>"; the version is bumped on every change, so passes
-- issued for an older password stop working and open sessions enter the new one.
ALTER TABLE files ADD COLUMN link_password TEXT;
ALTER TABLE files ADD COLUMN link_password_version INTEGER NOT NULL DEFAULT 0;
