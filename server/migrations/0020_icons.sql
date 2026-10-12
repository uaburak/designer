-- Organization and team icons (docs/multiplayer.md §14.16): Admin › Settings' organization icon and a team's
-- "Change icon". The image (PNG, JPEG, WebP or GIF, ≤ 1 MB, square-cropped by the app) lives in the org's
-- `FontObject` content-addressed by SHA-1; the row keeps its hash, served at /icons/<orgId>/<sha1> (immutable).
-- The bytes are charged to the uploader as stored item o:<orgId>:icon:<sha1> or o:<orgId>:team:<teamId>:icon:<sha1>.
-- teams.icon (0010, a data: URL) stays for teams iconed before this; an upload or Remove icon clears it.
ALTER TABLE orgs ADD COLUMN icon_hash TEXT;
ALTER TABLE teams ADD COLUMN icon_hash TEXT;
