CREATE TABLE IF NOT EXISTS chapter_payload_digest (
  chapter_id INTEGER PRIMARY KEY NOT NULL REFERENCES chapter(id) ON DELETE CASCADE,
  storage_dir TEXT NOT NULL,
  storage_signature TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  body_bytes INTEGER NOT NULL CHECK(body_bytes >= 0),
  payload_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TRIGGER IF NOT EXISTS chapter_payload_digest_clear_on_empty
AFTER UPDATE OF content_bytes, is_downloaded ON chapter
WHEN NEW.content_bytes = 0 AND NEW.is_downloaded = 0
BEGIN
  DELETE FROM chapter_payload_digest WHERE chapter_id = NEW.id;
END;
