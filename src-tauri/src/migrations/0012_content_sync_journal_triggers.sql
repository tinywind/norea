-- Journal chapter path rewrites and body-present incomplete media chapters for content sync.
DROP TRIGGER IF EXISTS content_sync_chapter_content_insert;
CREATE TRIGGER content_sync_chapter_content_insert
AFTER INSERT ON chapter
WHEN (SELECT remote FROM content_sync_origin WHERE id=1)=0 AND (NEW.is_downloaded=1 OR NEW.content_bytes>0)
BEGIN
  INSERT INTO content_sync_journal(state_key)
  SELECT 'content:' || json_array(n.plugin_id,n.path,NEW.path) FROM novel n WHERE n.id=NEW.novel_id;
END;

DROP TRIGGER IF EXISTS content_sync_chapter_content_update;
CREATE TRIGGER content_sync_chapter_content_update
AFTER UPDATE OF path,is_downloaded,stored_content_type,content_bytes,media_bytes,media_repair_needed,name,chapter_number,position,page,content_type ON chapter
WHEN (SELECT remote FROM content_sync_origin WHERE id=1)=0
BEGIN
  INSERT INTO content_sync_journal(state_key)
  SELECT 'content:' || json_array(n.plugin_id,n.path,OLD.path) FROM novel n WHERE n.id=OLD.novel_id AND OLD.path IS NOT NEW.path;
  INSERT INTO content_sync_journal(state_key)
  SELECT 'content:' || json_array(n.plugin_id,n.path,NEW.path) FROM novel n WHERE n.id=NEW.novel_id;
END;

DROP TRIGGER IF EXISTS content_sync_novel_metadata;
CREATE TRIGGER content_sync_novel_metadata
AFTER UPDATE OF name,author,summary,is_local,source_novel_id ON novel
WHEN (SELECT remote FROM content_sync_origin WHERE id=1)=0
BEGIN
  INSERT INTO content_sync_journal(state_key)
  SELECT 'content:' || json_array(NEW.plugin_id,NEW.path,c.path) FROM chapter c WHERE c.novel_id=NEW.id AND (c.is_downloaded=1 OR c.content_bytes>0);
END;

INSERT INTO content_sync_journal(state_key)
SELECT 'content:' || json_array(n.plugin_id,n.path,c.path)
FROM chapter c
JOIN novel n ON n.id=c.novel_id
WHERE c.is_downloaded=0 AND c.content_bytes>0;
