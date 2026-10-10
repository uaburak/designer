-- "Anyone with the link" (docs/multiplayer.md §3): a signed-in person with the file's link gets this role.
ALTER TABLE files ADD COLUMN link_access TEXT NOT NULL DEFAULT 'none' CHECK (link_access IN ('none', 'viewer', 'editor'));
