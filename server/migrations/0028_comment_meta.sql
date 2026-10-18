-- Rich text in a shared file's comments (docs/multiplayer.md §18.8; atlas 16 §2.6): Figma's `message_meta` — the message
-- as segments (bold, italic, strikethrough, links, lists, @mentions), JSON. `message` stays the plain text (search,
-- notifications, Discovery). NULL: plain text (every comment written before it).
ALTER TABLE comments ADD COLUMN message_meta TEXT;
