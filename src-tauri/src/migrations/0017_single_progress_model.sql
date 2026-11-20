-- Unify chapter reading state on progress (0 unread, 1..99 reading, 100 read) and drop unread columns.

DROP TRIGGER IF EXISTS work_metadata_preserve_reading;
DROP TRIGGER IF EXISTS chapter_stats_after_insert;
DROP TRIGGER IF EXISTS chapter_stats_after_update_same_novel;
DROP TRIGGER IF EXISTS chapter_stats_after_update_moved_novel;
DROP TRIGGER IF EXISTS chapter_stats_after_delete;
DROP INDEX IF EXISTS chapter_unread_found_position_idx;
DROP INDEX IF EXISTS chapter_found_by_check_idx;

UPDATE chapter
SET progress = 100
WHERE unread = 0 AND progress < 100;

UPDATE work_metadata_reading_state
SET progress = 100
WHERE unread = 0 AND progress < 100;

ALTER TABLE chapter DROP COLUMN unread;
ALTER TABLE work_metadata_reading_state DROP COLUMN unread;

CREATE INDEX chapter_progress_found_position_idx
ON chapter (progress, found_at, position, id);

CREATE INDEX chapter_found_by_check_idx
ON chapter (found_by_check, progress, found_at);

CREATE TRIGGER work_metadata_preserve_reading
BEFORE DELETE ON chapter
BEGIN
  INSERT INTO work_metadata_reading_state(plugin_id,novel_path,chapter_path,progress,bookmark,read_at)
  SELECT plugin_id,path,OLD.path,OLD.progress,OLD.bookmark,OLD.read_at FROM novel WHERE id=OLD.novel_id
  ON CONFLICT(plugin_id,novel_path,chapter_path) DO UPDATE SET progress=excluded.progress,bookmark=excluded.bookmark,read_at=excluded.read_at;
END;

CREATE TRIGGER chapter_stats_after_insert
AFTER INSERT ON chapter
BEGIN
  INSERT INTO novel_stats (
    novel_id,
    total_chapters,
    chapters_downloaded,
    chapters_unread,
    progress_sum,
    reading_progress,
    last_chapter_updated_at,
    updated_at
  )
  VALUES (
    NEW.novel_id,
    1,
    CASE WHEN NEW.is_downloaded = 1 THEN 1 ELSE 0 END,
    CASE WHEN NEW.progress < 100 THEN 1 ELSE 0 END,
    CASE
      WHEN NEW.progress >= 100 THEN 100
      WHEN NEW.progress < 0 THEN 0
      ELSE NEW.progress
    END,
    CASE
      WHEN NEW.progress >= 100 THEN 100
      WHEN NEW.progress < 0 THEN 0
      ELSE NEW.progress
    END,
    COALESCE(NEW.updated_at, 0),
    unixepoch()
  )
  ON CONFLICT(novel_id) DO UPDATE SET
    total_chapters = total_chapters + 1,
    chapters_downloaded =
      chapters_downloaded + excluded.chapters_downloaded,
    chapters_unread =
      chapters_unread + excluded.chapters_unread,
    progress_sum = progress_sum + excluded.progress_sum,
    reading_progress = ROUND(
      CAST(progress_sum + excluded.progress_sum AS REAL) /
      (total_chapters + 1)
    ),
    last_chapter_updated_at = MAX(
      last_chapter_updated_at,
      excluded.last_chapter_updated_at
    ),
    updated_at = unixepoch();
END;

CREATE TRIGGER chapter_stats_after_update_same_novel
AFTER UPDATE ON chapter
WHEN OLD.novel_id = NEW.novel_id
BEGIN
  UPDATE novel_stats
  SET
    chapters_downloaded = MAX(
      chapters_downloaded +
        CASE WHEN NEW.is_downloaded = 1 THEN 1 ELSE 0 END -
        CASE WHEN OLD.is_downloaded = 1 THEN 1 ELSE 0 END,
      0
    ),
    chapters_unread = MAX(
      chapters_unread +
        CASE WHEN NEW.progress < 100 THEN 1 ELSE 0 END -
        CASE WHEN OLD.progress < 100 THEN 1 ELSE 0 END,
      0
    ),
    progress_sum = MAX(
      progress_sum +
        CASE
          WHEN NEW.progress >= 100 THEN 100
          WHEN NEW.progress < 0 THEN 0
          ELSE NEW.progress
        END -
        CASE
          WHEN OLD.progress >= 100 THEN 100
          WHEN OLD.progress < 0 THEN 0
          ELSE OLD.progress
        END,
      0
    ),
    reading_progress = CASE
      WHEN total_chapters > 0 THEN ROUND(
        CAST(MAX(
          progress_sum +
            CASE
              WHEN NEW.progress >= 100 THEN 100
              WHEN NEW.progress < 0 THEN 0
              ELSE NEW.progress
            END -
            CASE
              WHEN OLD.progress >= 100 THEN 100
              WHEN OLD.progress < 0 THEN 0
              ELSE OLD.progress
            END,
          0
        ) AS REAL) / total_chapters
      )
      ELSE 0
    END,
    last_chapter_updated_at = CASE
      WHEN COALESCE(NEW.updated_at, 0) >= last_chapter_updated_at
        THEN COALESCE(NEW.updated_at, 0)
      WHEN COALESCE(OLD.updated_at, 0) = last_chapter_updated_at
        THEN COALESCE(
          (
            SELECT MAX(c.updated_at)
            FROM chapter c
            WHERE c.novel_id = NEW.novel_id
          ),
          0
        )
      ELSE last_chapter_updated_at
    END,
    updated_at = unixepoch()
  WHERE novel_id = NEW.novel_id;
END;

CREATE TRIGGER chapter_stats_after_update_moved_novel
AFTER UPDATE OF novel_id ON chapter
WHEN OLD.novel_id <> NEW.novel_id
BEGIN
  UPDATE novel_stats
  SET
    total_chapters = MAX(total_chapters - 1, 0),
    chapters_downloaded = MAX(
      chapters_downloaded -
        CASE WHEN OLD.is_downloaded = 1 THEN 1 ELSE 0 END,
      0
    ),
    chapters_unread = MAX(
      chapters_unread -
        CASE WHEN OLD.progress < 100 THEN 1 ELSE 0 END,
      0
    ),
    progress_sum = MAX(
      progress_sum -
        CASE
          WHEN OLD.progress >= 100 THEN 100
          WHEN OLD.progress < 0 THEN 0
          ELSE OLD.progress
        END,
      0
    ),
    reading_progress = CASE
      WHEN total_chapters > 1 THEN ROUND(
        CAST(MAX(
          progress_sum -
            CASE
              WHEN OLD.progress >= 100 THEN 100
              WHEN OLD.progress < 0 THEN 0
              ELSE OLD.progress
            END,
          0
        ) AS REAL) / (total_chapters - 1)
      )
      ELSE 0
    END,
    last_chapter_updated_at = CASE
      WHEN COALESCE(OLD.updated_at, 0) = last_chapter_updated_at
        THEN COALESCE(
          (
            SELECT MAX(c.updated_at)
            FROM chapter c
            WHERE c.novel_id = OLD.novel_id
          ),
          0
        )
      ELSE last_chapter_updated_at
    END,
    updated_at = unixepoch()
  WHERE novel_id = OLD.novel_id;

  INSERT INTO novel_stats (
    novel_id,
    total_chapters,
    chapters_downloaded,
    chapters_unread,
    progress_sum,
    reading_progress,
    last_chapter_updated_at,
    updated_at
  )
  VALUES (
    NEW.novel_id,
    1,
    CASE WHEN NEW.is_downloaded = 1 THEN 1 ELSE 0 END,
    CASE WHEN NEW.progress < 100 THEN 1 ELSE 0 END,
    CASE
      WHEN NEW.progress >= 100 THEN 100
      WHEN NEW.progress < 0 THEN 0
      ELSE NEW.progress
    END,
    CASE
      WHEN NEW.progress >= 100 THEN 100
      WHEN NEW.progress < 0 THEN 0
      ELSE NEW.progress
    END,
    COALESCE(NEW.updated_at, 0),
    unixepoch()
  )
  ON CONFLICT(novel_id) DO UPDATE SET
    total_chapters = total_chapters + 1,
    chapters_downloaded =
      chapters_downloaded + excluded.chapters_downloaded,
    chapters_unread =
      chapters_unread + excluded.chapters_unread,
    progress_sum = progress_sum + excluded.progress_sum,
    reading_progress = ROUND(
      CAST(progress_sum + excluded.progress_sum AS REAL) /
      (total_chapters + 1)
    ),
    last_chapter_updated_at = MAX(
      last_chapter_updated_at,
      excluded.last_chapter_updated_at
    ),
    updated_at = unixepoch();
END;

CREATE TRIGGER chapter_stats_after_delete
AFTER DELETE ON chapter
BEGIN
  UPDATE novel_stats
  SET
    total_chapters = MAX(total_chapters - 1, 0),
    chapters_downloaded = MAX(
      chapters_downloaded -
        CASE WHEN OLD.is_downloaded = 1 THEN 1 ELSE 0 END,
      0
    ),
    chapters_unread = MAX(
      chapters_unread -
        CASE WHEN OLD.progress < 100 THEN 1 ELSE 0 END,
      0
    ),
    progress_sum = MAX(
      progress_sum -
        CASE
          WHEN OLD.progress >= 100 THEN 100
          WHEN OLD.progress < 0 THEN 0
          ELSE OLD.progress
        END,
      0
    ),
    reading_progress = CASE
      WHEN total_chapters > 1 THEN ROUND(
        CAST(MAX(
          progress_sum -
            CASE
              WHEN OLD.progress >= 100 THEN 100
              WHEN OLD.progress < 0 THEN 0
              ELSE OLD.progress
            END,
          0
        ) AS REAL) / (total_chapters - 1)
      )
      ELSE 0
    END,
    last_chapter_updated_at = CASE
      WHEN COALESCE(OLD.updated_at, 0) = last_chapter_updated_at
        THEN COALESCE(
          (
            SELECT MAX(c.updated_at)
            FROM chapter c
            WHERE c.novel_id = OLD.novel_id
          ),
          0
        )
      ELSE last_chapter_updated_at
    END,
    updated_at = unixepoch()
  WHERE novel_id = OLD.novel_id;
END;

-- Recompute novel_stats to reflect normalized chapter progress values.
UPDATE novel_stats
SET
  chapters_unread = COALESCE(
    (SELECT SUM(CASE WHEN c.progress < 100 THEN 1 ELSE 0 END)
     FROM chapter c WHERE c.novel_id = novel_stats.novel_id),
    0
  ),
  progress_sum = COALESCE(
    (SELECT SUM(
      CASE
        WHEN c.progress >= 100 THEN 100
        WHEN c.progress < 0 THEN 0
        ELSE c.progress
      END
    ) FROM chapter c WHERE c.novel_id = novel_stats.novel_id),
    0
  ),
  reading_progress = CASE
    WHEN total_chapters > 0 THEN ROUND(
      CAST(COALESCE(
        (SELECT SUM(
          CASE
            WHEN c.progress >= 100 THEN 100
            WHEN c.progress < 0 THEN 0
            ELSE c.progress
          END
        ) FROM chapter c WHERE c.novel_id = novel_stats.novel_id),
        0
      ) AS REAL) / total_chapters
    )
    ELSE 0
  END,
  updated_at = unixepoch();

-- Normalize reading JSON payloads in local user-state tables.
UPDATE user_state_intent
SET value_json = json_remove(
  CASE
    WHEN json_type(value_json, '$.unread') = 'false'
      AND COALESCE(CAST(json_extract(value_json, '$.progress') AS REAL), 0) < 100
      THEN json_set(value_json, '$.progress', 100)
    ELSE value_json
  END,
  '$.unread'
)
WHERE json_extract(entity_json, '$.kind') = 'reading'
  AND json_type(value_json, '$.unread') IS NOT NULL;

UPDATE user_state_record
SET payload = json_remove(
  CASE
    WHEN json_type(payload, '$.value.unread') = 'false'
      AND COALESCE(CAST(json_extract(payload, '$.value.progress') AS REAL), 0) < 100
      THEN json_set(payload, '$.value.progress', 100)
    ELSE payload
  END,
  '$.value.unread'
)
WHERE json_extract(payload, '$.entity.kind') = 'reading'
  AND json_type(payload, '$.value.unread') IS NOT NULL;

UPDATE user_state_private
SET public_value_json = json_remove(
  CASE
    WHEN json_type(public_value_json, '$.unread') = 'false'
      AND COALESCE(CAST(json_extract(public_value_json, '$.progress') AS REAL), 0) < 100
      THEN json_set(public_value_json, '$.progress', 100)
    ELSE public_value_json
  END,
  '$.unread'
)
WHERE json_type(public_value_json, '$.unread') IS NOT NULL;

-- Drop pending reading operations containing legacy unread so a fresh operation_id is minted
-- from the normalized user_state_intent instead of colliding on operation_id payload hash.
DELETE FROM user_state_operation
WHERE status = 'pending'
  AND json_extract(payload, '$.entity.kind') = 'reading'
  AND json_type(payload, '$.value.unread') IS NOT NULL;

UPDATE user_state_operation
SET payload = json_remove(
  CASE
    WHEN json_type(payload, '$.value.unread') = 'false'
      AND COALESCE(CAST(json_extract(payload, '$.value.progress') AS REAL), 0) < 100
      THEN json_set(payload, '$.value.progress', 100)
    ELSE payload
  END,
  '$.value.unread'
)
WHERE json_extract(payload, '$.entity.kind') = 'reading'
  AND json_type(payload, '$.value.unread') IS NOT NULL;

UPDATE user_state_operation
SET receipt = json_remove(
  CASE
    WHEN json_type(receipt, '$.current.value.unread') = 'false'
      AND COALESCE(CAST(json_extract(receipt, '$.current.value.progress') AS REAL), 0) < 100
      THEN json_set(receipt, '$.current.value.progress', 100)
    ELSE receipt
  END,
  '$.current.value.unread'
)
WHERE receipt IS NOT NULL
  AND json_extract(receipt, '$.current.entity.kind') = 'reading'
  AND json_type(receipt, '$.current.value.unread') IS NOT NULL;

-- Clean up retired current-snapshot user-state cache keys.
DELETE FROM content_sync_cache
WHERE cache_key LIKE 'user-state-current:%'
   OR cache_key LIKE 'user-state-current-status:%'
   OR cache_key LIKE 'user-state-current-export:%';
