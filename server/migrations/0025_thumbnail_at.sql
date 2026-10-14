-- When a file's thumbnail was last uploaded (OrgFile.thumbnailUrl's `?v=`, so Home asks for a new picture after each
-- one): kept apart from updated_at, which says when the file was edited — a thumbnail made on open isn't an edit.
-- NULL: no thumbnail yet (the card shows none and asks for none).
ALTER TABLE files ADD COLUMN thumbnail_at INTEGER;
