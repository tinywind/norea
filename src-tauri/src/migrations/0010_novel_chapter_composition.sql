-- Keep the source catalog and the user's composed chapter list as separate durable data.
CREATE TABLE novel_chapter_composition (
  novel_id INTEGER PRIMARY KEY NOT NULL REFERENCES novel(id) ON DELETE CASCADE,
  payload TEXT NOT NULL
);

CREATE TRIGGER work_metadata_composition_insert
AFTER INSERT ON novel_chapter_composition
BEGIN
  INSERT INTO work_metadata_dirty(plugin_id,path)
  SELECT plugin_id,path FROM novel WHERE id=NEW.novel_id
  ON CONFLICT(plugin_id,path) DO NOTHING;
END;

CREATE TRIGGER work_metadata_composition_update
AFTER UPDATE ON novel_chapter_composition
WHEN OLD.payload IS NOT NEW.payload OR OLD.novel_id IS NOT NEW.novel_id
BEGIN
  INSERT INTO work_metadata_dirty(plugin_id,path)
  SELECT plugin_id,path FROM novel WHERE id IN (OLD.novel_id,NEW.novel_id)
  ON CONFLICT(plugin_id,path) DO NOTHING;
END;

CREATE TRIGGER work_metadata_composition_delete
AFTER DELETE ON novel_chapter_composition
BEGIN
  INSERT INTO work_metadata_dirty(plugin_id,path)
  SELECT plugin_id,path FROM novel WHERE id=OLD.novel_id
  ON CONFLICT(plugin_id,path) DO NOTHING;
END;
