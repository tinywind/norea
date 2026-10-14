CREATE TABLE `work_metadata_dirty` (
  `plugin_id` text NOT NULL,
  `path` text NOT NULL,
  PRIMARY KEY (`plugin_id`, `path`)
);
--> statement-breakpoint
CREATE TABLE `work_metadata_cache_state` (
  `id` integer PRIMARY KEY,
  CONSTRAINT `work_metadata_cache_state_singleton` CHECK (`id` = 1)
);
--> statement-breakpoint
CREATE TABLE `work_metadata_file_cache` (
  `plugin_id` text NOT NULL,
  `path` text NOT NULL,
  `novel_id` integer NOT NULL,
  `directory` text NOT NULL,
  `fingerprint` text NOT NULL,
  PRIMARY KEY (`plugin_id`, `path`)
);
--> statement-breakpoint
CREATE TABLE `work_metadata_sync_journal` (
  `plugin_id` text NOT NULL,
  `path` text NOT NULL,
  `revision` integer NOT NULL,
  PRIMARY KEY (`plugin_id`, `path`)
);
--> statement-breakpoint
CREATE TABLE `work_metadata_directory_cache` (
  `chapter_id` integer PRIMARY KEY,
  `novel_id` integer NOT NULL,
  `directory` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `work_metadata_directory_novel` ON `work_metadata_directory_cache` (`novel_id`);
--> statement-breakpoint
CREATE TABLE `work_metadata_reading_state` (
  `plugin_id` text NOT NULL,
  `novel_path` text NOT NULL,
  `chapter_path` text NOT NULL,
  `progress` integer NOT NULL,
  `bookmark` integer NOT NULL,
  `unread` integer NOT NULL,
  `read_at` integer,
  PRIMARY KEY (`plugin_id`, `novel_path`, `chapter_path`)
);
--> statement-breakpoint
CREATE TABLE `novel` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `plugin_id` text NOT NULL,
  `path` text NOT NULL,
  `name` text NOT NULL,
  `cover` text,
  `summary` text,
  `author` text,
  `artist` text,
  `status` text,
  `genres` text,
  `rating` real,
  `in_library` integer DEFAULT false NOT NULL,
  `is_local` integer DEFAULT false NOT NULL,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch()) NOT NULL,
  `library_added_at` integer,
  `last_read_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `novel_plugin_path_uniq` ON `novel` (`plugin_id`, `path`);
--> statement-breakpoint
CREATE INDEX `novel_in_library_idx` ON `novel` (`in_library`);
--> statement-breakpoint
CREATE TABLE `chapter` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `novel_id` integer NOT NULL,
  `path` text NOT NULL,
  `name` text NOT NULL,
  `chapter_number` text,
  `position` integer NOT NULL,
  `page` text DEFAULT '1' NOT NULL,
  `bookmark` integer DEFAULT false NOT NULL,
  `unread` integer DEFAULT true NOT NULL,
  `progress` integer DEFAULT 0 NOT NULL,
  `is_downloaded` integer DEFAULT false NOT NULL,
  `content_type` text DEFAULT 'html' NOT NULL,
  `stored_content_type` text,
  `content_bytes` integer DEFAULT 0 NOT NULL,
  `media_bytes` integer DEFAULT 0 NOT NULL,
  `media_repair_needed` integer DEFAULT false NOT NULL,
  `media_bytes_checked_at` integer,
  `release_time` text,
  `read_at` integer,
  `created_at` integer,
  `found_at` integer DEFAULT 0 NOT NULL,
  `updated_at` integer DEFAULT (unixepoch()) NOT NULL,
  FOREIGN KEY (`novel_id`) REFERENCES `novel`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chapter_novel_path_uniq` ON `chapter` (`novel_id`, `path`);
--> statement-breakpoint
CREATE INDEX `chapter_novel_position_idx` ON `chapter` (`novel_id`, `position`);
--> statement-breakpoint
CREATE INDEX `chapter_downloaded_updated_idx` ON `chapter` (`is_downloaded`, `updated_at`, `novel_id`);
--> statement-breakpoint
CREATE INDEX `chapter_novel_downloaded_position_idx` ON `chapter` (`novel_id`, `is_downloaded`, `position`, `id`);
--> statement-breakpoint
CREATE INDEX `chapter_unread_found_position_idx` ON `chapter` (`unread`, `found_at`, `position`, `id`);
--> statement-breakpoint
CREATE TABLE `novel_stats` (
  `novel_id` integer PRIMARY KEY NOT NULL,
  `total_chapters` integer DEFAULT 0 NOT NULL,
  `chapters_downloaded` integer DEFAULT 0 NOT NULL,
  `chapters_unread` integer DEFAULT 0 NOT NULL,
  `progress_sum` integer DEFAULT 0 NOT NULL,
  `reading_progress` integer DEFAULT 0 NOT NULL,
  `last_chapter_updated_at` integer DEFAULT 0 NOT NULL,
  `updated_at` integer DEFAULT (unixepoch()) NOT NULL,
  FOREIGN KEY (`novel_id`) REFERENCES `novel`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `novel_stats_downloaded_idx` ON `novel_stats` (`chapters_downloaded`);
--> statement-breakpoint
CREATE INDEX `novel_stats_unread_idx` ON `novel_stats` (`chapters_unread`);
--> statement-breakpoint
CREATE INDEX `novel_stats_total_idx` ON `novel_stats` (`total_chapters`);
--> statement-breakpoint
CREATE INDEX `novel_stats_last_chapter_updated_idx` ON `novel_stats` (`last_chapter_updated_at`);
--> statement-breakpoint
CREATE TABLE `category` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `name` text NOT NULL,
  `sort` integer NOT NULL,
  `is_system` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `category_name_uniq` ON `category` (`name`);
--> statement-breakpoint
CREATE INDEX `category_sort_idx` ON `category` (`sort`);
--> statement-breakpoint
CREATE TABLE `novel_category` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `novel_id` integer NOT NULL,
  `category_id` integer NOT NULL,
  FOREIGN KEY (`novel_id`) REFERENCES `novel`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`category_id`) REFERENCES `category`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `novel_category_uniq` ON `novel_category` (`novel_id`, `category_id`);
--> statement-breakpoint
CREATE INDEX `novel_category_category_idx` ON `novel_category` (`category_id`);
--> statement-breakpoint
CREATE TABLE `repository` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `url` text NOT NULL,
  `name` text,
  `added_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repository_url_uniq` ON `repository` (`url`);
--> statement-breakpoint
CREATE UNIQUE INDEX `repository_singleton_uniq` ON `repository` ((1));
--> statement-breakpoint
CREATE TABLE `installed_plugin` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `lang` text NOT NULL,
  `version` text NOT NULL,
  `icon_url` text NOT NULL,
  `source_url` text NOT NULL,
  `source_code` text NOT NULL,
  `installed_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `repository_index_cache` (
  `repo_url` text PRIMARY KEY NOT NULL,
  `fetched_at` integer DEFAULT (unixepoch()) NOT NULL,
  `items_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `chapter_download_queue` (
  `chapter_id` integer PRIMARY KEY NOT NULL,
  `job_json` text NOT NULL,
  `created_at_ms` integer NOT NULL,
  `updated_at_ms` integer NOT NULL,
  `leased_at_ms` integer,
  `attempt_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `chapter_download_queue_created_idx`
ON `chapter_download_queue` (`created_at_ms`, `chapter_id`);
--> statement-breakpoint
CREATE TABLE `download_cache_work` (
  `id` text PRIMARY KEY NOT NULL,
  `scope` text NOT NULL,
  `target_ids_json` text NOT NULL,
  `title` text,
  `status` text DEFAULT 'queued' NOT NULL,
  `total` integer DEFAULT 0 NOT NULL,
  `completed` integer DEFAULT 0 NOT NULL,
  `failed` integer DEFAULT 0 NOT NULL,
  `error` text,
  `cancel_requested` integer DEFAULT 0 NOT NULL,
  `created_at_ms` integer NOT NULL,
  `updated_at_ms` integer NOT NULL,
  `started_at_ms` integer,
  `finished_at_ms` integer
);
--> statement-breakpoint
CREATE INDEX `download_cache_work_status_idx`
ON `download_cache_work` (`status`, `updated_at_ms`);
--> statement-breakpoint
CREATE TABLE `vpn_gate_server_verdict` (
  `ip` text PRIMARY KEY NOT NULL,
  `verdict` text NOT NULL,
  `updated_at` integer DEFAULT (unixepoch()) NOT NULL,
  CONSTRAINT `vpn_gate_server_verdict_verdict_check`
    CHECK (`verdict` IN ('works', 'fails'))
);
--> statement-breakpoint
CREATE TABLE `content_sync_cache` (
  `cache_key` text PRIMARY KEY NOT NULL,
  `payload` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `content_sync_origin` (
  `id` integer PRIMARY KEY NOT NULL,
  `remote` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
INSERT INTO `content_sync_origin` (`id`, `remote`) VALUES (1, 0);
--> statement-breakpoint
CREATE TABLE `content_sync_journal` (
  `sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `state_key` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `content_sync_journal_key_idx` ON `content_sync_journal` (`state_key`, `sequence`);
--> statement-breakpoint
CREATE TRIGGER `content_sync_novel_content_delete`
BEFORE DELETE ON `novel`
WHEN (SELECT remote FROM content_sync_origin WHERE id=1)=0
BEGIN
  INSERT INTO content_sync_journal(state_key)
  SELECT 'content:' || json_array(OLD.plugin_id,OLD.path,c.path) FROM chapter c WHERE c.novel_id=OLD.id;
END;
--> statement-breakpoint
CREATE TRIGGER `content_sync_chapter_content_delete`
BEFORE DELETE ON `chapter`
WHEN (SELECT remote FROM content_sync_origin WHERE id=1)=0
BEGIN
  INSERT INTO content_sync_journal(state_key)
  SELECT 'content:' || json_array(n.plugin_id,n.path,OLD.path) FROM novel n WHERE n.id=OLD.novel_id;
END;
--> statement-breakpoint
CREATE TRIGGER `content_sync_chapter_content_insert`
AFTER INSERT ON `chapter`
WHEN (SELECT remote FROM content_sync_origin WHERE id=1)=0 AND NEW.is_downloaded=1
BEGIN
  INSERT INTO content_sync_journal(state_key)
  SELECT 'content:' || json_array(n.plugin_id,n.path,NEW.path) FROM novel n WHERE n.id=NEW.novel_id;
END;
--> statement-breakpoint
CREATE TRIGGER `content_sync_chapter_content_update`
AFTER UPDATE OF is_downloaded,stored_content_type,content_bytes,media_bytes,media_repair_needed,name,chapter_number,position,page,content_type ON `chapter`
WHEN (SELECT remote FROM content_sync_origin WHERE id=1)=0
BEGIN
  INSERT INTO content_sync_journal(state_key)
  SELECT 'content:' || json_array(n.plugin_id,n.path,NEW.path) FROM novel n WHERE n.id=NEW.novel_id;
END;
--> statement-breakpoint
CREATE TRIGGER `content_sync_novel_metadata`
AFTER UPDATE OF name,author,summary,is_local ON `novel`
WHEN (SELECT remote FROM content_sync_origin WHERE id=1)=0
BEGIN
  INSERT INTO content_sync_journal(state_key)
  SELECT 'content:' || json_array(NEW.plugin_id,NEW.path,c.path) FROM chapter c WHERE c.novel_id=NEW.id AND c.is_downloaded=1;
END;
--> statement-breakpoint
CREATE TRIGGER `work_metadata_preserve_reading`
BEFORE DELETE ON `chapter`
BEGIN
  INSERT INTO work_metadata_reading_state(plugin_id,novel_path,chapter_path,progress,bookmark,unread,read_at)
  SELECT plugin_id,path,OLD.path,OLD.progress,OLD.bookmark,OLD.unread,OLD.read_at FROM novel WHERE id=OLD.novel_id
  ON CONFLICT(plugin_id,novel_path,chapter_path) DO UPDATE SET progress=excluded.progress,bookmark=excluded.bookmark,unread=excluded.unread,read_at=excluded.read_at;
END;
--> statement-breakpoint
CREATE TRIGGER `work_metadata_novel_insert`
AFTER INSERT ON `novel`
BEGIN
  INSERT INTO work_metadata_dirty(plugin_id,path) SELECT NEW.plugin_id,NEW.path WHERE true
  ON CONFLICT(plugin_id,path) DO NOTHING;
END;
--> statement-breakpoint
CREATE TRIGGER `work_metadata_novel_update`
AFTER UPDATE ON `novel`
WHEN OLD.plugin_id IS NOT NEW.plugin_id OR OLD.path IS NOT NEW.path OR OLD.name IS NOT NEW.name
  OR OLD.cover IS NOT NEW.cover OR OLD.author IS NOT NEW.author OR OLD.artist IS NOT NEW.artist
  OR OLD.summary IS NOT NEW.summary OR OLD.status IS NOT NEW.status OR OLD.genres IS NOT NEW.genres
  OR OLD.rating IS NOT NEW.rating OR OLD.is_local IS NOT NEW.is_local
BEGIN
  INSERT INTO work_metadata_dirty(plugin_id,path) SELECT NEW.plugin_id,NEW.path WHERE true
  ON CONFLICT(plugin_id,path) DO NOTHING;
END;
--> statement-breakpoint
CREATE TRIGGER `work_metadata_novel_delete`
AFTER DELETE ON `novel`
BEGIN
  INSERT INTO work_metadata_dirty(plugin_id,path) SELECT OLD.plugin_id,OLD.path WHERE true
  ON CONFLICT(plugin_id,path) DO NOTHING;
END;
--> statement-breakpoint
CREATE TRIGGER `work_metadata_chapter_insert`
AFTER INSERT ON `chapter`
BEGIN
  INSERT INTO work_metadata_dirty(plugin_id,path) SELECT plugin_id,path FROM novel WHERE id=NEW.novel_id
  ON CONFLICT(plugin_id,path) DO NOTHING;
END;
--> statement-breakpoint
CREATE TRIGGER `work_metadata_chapter_update`
AFTER UPDATE ON `chapter`
WHEN OLD.novel_id IS NOT NEW.novel_id OR OLD.path IS NOT NEW.path OR OLD.name IS NOT NEW.name
  OR OLD.chapter_number IS NOT NEW.chapter_number OR OLD.position IS NOT NEW.position
  OR OLD.page IS NOT NEW.page OR OLD.content_type IS NOT NEW.content_type OR OLD.release_time IS NOT NEW.release_time
BEGIN
  INSERT INTO work_metadata_dirty(plugin_id,path) SELECT plugin_id,path FROM novel WHERE id=NEW.novel_id
  ON CONFLICT(plugin_id,path) DO NOTHING;
END;
--> statement-breakpoint
CREATE TRIGGER `work_metadata_chapter_delete`
AFTER DELETE ON `chapter`
BEGIN
  INSERT INTO work_metadata_dirty(plugin_id,path) SELECT plugin_id,path FROM novel WHERE id=OLD.novel_id
  ON CONFLICT(plugin_id,path) DO NOTHING;
END;
--> statement-breakpoint
CREATE TRIGGER `chapter_stats_after_insert`
AFTER INSERT ON `chapter`
BEGIN
  INSERT INTO `novel_stats` (
    `novel_id`,
    `total_chapters`,
    `chapters_downloaded`,
    `chapters_unread`,
    `progress_sum`,
    `reading_progress`,
    `last_chapter_updated_at`,
    `updated_at`
  )
  VALUES (
    NEW.`novel_id`,
    1,
    CASE WHEN NEW.`is_downloaded` = 1 THEN 1 ELSE 0 END,
    CASE WHEN NEW.`unread` = 1 THEN 1 ELSE 0 END,
    CASE
      WHEN NEW.`progress` >= 100 THEN 100
      WHEN NEW.`progress` < 0 THEN 0
      WHEN NEW.`progress` > 100 THEN 100
      ELSE NEW.`progress`
    END,
    CASE
      WHEN NEW.`progress` >= 100 THEN 100
      WHEN NEW.`progress` < 0 THEN 0
      WHEN NEW.`progress` > 100 THEN 100
      ELSE NEW.`progress`
    END,
    COALESCE(NEW.`updated_at`, 0),
    unixepoch()
  )
  ON CONFLICT(`novel_id`) DO UPDATE SET
    `total_chapters` = `total_chapters` + 1,
    `chapters_downloaded` =
      `chapters_downloaded` + excluded.`chapters_downloaded`,
    `chapters_unread` =
      `chapters_unread` + excluded.`chapters_unread`,
    `progress_sum` = `progress_sum` + excluded.`progress_sum`,
    `reading_progress` = ROUND(
      CAST(`progress_sum` + excluded.`progress_sum` AS REAL) /
      (`total_chapters` + 1)
    ),
    `last_chapter_updated_at` = MAX(
      `last_chapter_updated_at`,
      excluded.`last_chapter_updated_at`
    ),
    `updated_at` = unixepoch();
END;
--> statement-breakpoint
CREATE TRIGGER `chapter_stats_after_update_same_novel`
AFTER UPDATE ON `chapter`
WHEN OLD.`novel_id` = NEW.`novel_id`
BEGIN
  UPDATE `novel_stats`
  SET
    `chapters_downloaded` = MAX(
      `chapters_downloaded` +
        CASE WHEN NEW.`is_downloaded` = 1 THEN 1 ELSE 0 END -
        CASE WHEN OLD.`is_downloaded` = 1 THEN 1 ELSE 0 END,
      0
    ),
    `chapters_unread` = MAX(
      `chapters_unread` +
        CASE WHEN NEW.`unread` = 1 THEN 1 ELSE 0 END -
        CASE WHEN OLD.`unread` = 1 THEN 1 ELSE 0 END,
      0
    ),
    `progress_sum` = MAX(
      `progress_sum` +
        CASE
          WHEN NEW.`progress` >= 100 THEN 100
          WHEN NEW.`progress` < 0 THEN 0
          WHEN NEW.`progress` > 100 THEN 100
          ELSE NEW.`progress`
        END -
        CASE
          WHEN OLD.`progress` >= 100 THEN 100
          WHEN OLD.`progress` < 0 THEN 0
          WHEN OLD.`progress` > 100 THEN 100
          ELSE OLD.`progress`
        END,
      0
    ),
    `reading_progress` = CASE
      WHEN `total_chapters` > 0 THEN ROUND(
        CAST(MAX(
          `progress_sum` +
            CASE
              WHEN NEW.`progress` >= 100 THEN 100
              WHEN NEW.`progress` < 0 THEN 0
              WHEN NEW.`progress` > 100 THEN 100
              ELSE NEW.`progress`
            END -
            CASE
              WHEN OLD.`progress` >= 100 THEN 100
              WHEN OLD.`progress` < 0 THEN 0
              WHEN OLD.`progress` > 100 THEN 100
              ELSE OLD.`progress`
            END,
          0
        ) AS REAL) / `total_chapters`
      )
      ELSE 0
    END,
    `last_chapter_updated_at` = CASE
      WHEN COALESCE(NEW.`updated_at`, 0) >= `last_chapter_updated_at`
        THEN COALESCE(NEW.`updated_at`, 0)
      WHEN COALESCE(OLD.`updated_at`, 0) = `last_chapter_updated_at`
        THEN COALESCE(
          (
            SELECT MAX(c.`updated_at`)
            FROM `chapter` c
            WHERE c.`novel_id` = NEW.`novel_id`
          ),
          0
        )
      ELSE `last_chapter_updated_at`
    END,
    `updated_at` = unixepoch()
  WHERE `novel_id` = NEW.`novel_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `chapter_stats_after_update_moved_novel`
AFTER UPDATE OF `novel_id` ON `chapter`
WHEN OLD.`novel_id` <> NEW.`novel_id`
BEGIN
  UPDATE `novel_stats`
  SET
    `total_chapters` = MAX(`total_chapters` - 1, 0),
    `chapters_downloaded` = MAX(
      `chapters_downloaded` -
        CASE WHEN OLD.`is_downloaded` = 1 THEN 1 ELSE 0 END,
      0
    ),
    `chapters_unread` = MAX(
      `chapters_unread` -
        CASE WHEN OLD.`unread` = 1 THEN 1 ELSE 0 END,
      0
    ),
    `progress_sum` = MAX(
      `progress_sum` -
        CASE
          WHEN OLD.`progress` >= 100 THEN 100
          WHEN OLD.`progress` < 0 THEN 0
          WHEN OLD.`progress` > 100 THEN 100
          ELSE OLD.`progress`
        END,
      0
    ),
    `reading_progress` = CASE
      WHEN `total_chapters` > 1 THEN ROUND(
        CAST(MAX(
          `progress_sum` -
            CASE
              WHEN OLD.`progress` >= 100 THEN 100
              WHEN OLD.`progress` < 0 THEN 0
              WHEN OLD.`progress` > 100 THEN 100
              ELSE OLD.`progress`
            END,
          0
        ) AS REAL) / (`total_chapters` - 1)
      )
      ELSE 0
    END,
    `last_chapter_updated_at` = CASE
      WHEN COALESCE(OLD.`updated_at`, 0) = `last_chapter_updated_at`
        THEN COALESCE(
          (
            SELECT MAX(c.`updated_at`)
            FROM `chapter` c
            WHERE c.`novel_id` = OLD.`novel_id`
          ),
          0
        )
      ELSE `last_chapter_updated_at`
    END,
    `updated_at` = unixepoch()
  WHERE `novel_id` = OLD.`novel_id`;

  INSERT INTO `novel_stats` (
    `novel_id`,
    `total_chapters`,
    `chapters_downloaded`,
    `chapters_unread`,
    `progress_sum`,
    `reading_progress`,
    `last_chapter_updated_at`,
    `updated_at`
  )
  VALUES (
    NEW.`novel_id`,
    1,
    CASE WHEN NEW.`is_downloaded` = 1 THEN 1 ELSE 0 END,
    CASE WHEN NEW.`unread` = 1 THEN 1 ELSE 0 END,
    CASE
      WHEN NEW.`progress` >= 100 THEN 100
      WHEN NEW.`progress` < 0 THEN 0
      WHEN NEW.`progress` > 100 THEN 100
      ELSE NEW.`progress`
    END,
    CASE
      WHEN NEW.`progress` >= 100 THEN 100
      WHEN NEW.`progress` < 0 THEN 0
      WHEN NEW.`progress` > 100 THEN 100
      ELSE NEW.`progress`
    END,
    COALESCE(NEW.`updated_at`, 0),
    unixepoch()
  )
  ON CONFLICT(`novel_id`) DO UPDATE SET
    `total_chapters` = `total_chapters` + 1,
    `chapters_downloaded` =
      `chapters_downloaded` + excluded.`chapters_downloaded`,
    `chapters_unread` =
      `chapters_unread` + excluded.`chapters_unread`,
    `progress_sum` = `progress_sum` + excluded.`progress_sum`,
    `reading_progress` = ROUND(
      CAST(`progress_sum` + excluded.`progress_sum` AS REAL) /
      (`total_chapters` + 1)
    ),
    `last_chapter_updated_at` = MAX(
      `last_chapter_updated_at`,
      excluded.`last_chapter_updated_at`
    ),
    `updated_at` = unixepoch();
END;
--> statement-breakpoint
CREATE TRIGGER `chapter_stats_after_delete`
AFTER DELETE ON `chapter`
BEGIN
  UPDATE `novel_stats`
  SET
    `total_chapters` = MAX(`total_chapters` - 1, 0),
    `chapters_downloaded` = MAX(
      `chapters_downloaded` -
        CASE WHEN OLD.`is_downloaded` = 1 THEN 1 ELSE 0 END,
      0
    ),
    `chapters_unread` = MAX(
      `chapters_unread` -
        CASE WHEN OLD.`unread` = 1 THEN 1 ELSE 0 END,
      0
    ),
    `progress_sum` = MAX(
      `progress_sum` -
        CASE
          WHEN OLD.`progress` >= 100 THEN 100
          WHEN OLD.`progress` < 0 THEN 0
          WHEN OLD.`progress` > 100 THEN 100
          ELSE OLD.`progress`
        END,
      0
    ),
    `reading_progress` = CASE
      WHEN `total_chapters` > 1 THEN ROUND(
        CAST(MAX(
          `progress_sum` -
            CASE
              WHEN OLD.`progress` >= 100 THEN 100
              WHEN OLD.`progress` < 0 THEN 0
              WHEN OLD.`progress` > 100 THEN 100
              ELSE OLD.`progress`
            END,
          0
        ) AS REAL) / (`total_chapters` - 1)
      )
      ELSE 0
    END,
    `last_chapter_updated_at` = CASE
      WHEN COALESCE(OLD.`updated_at`, 0) = `last_chapter_updated_at`
        THEN COALESCE(
          (
            SELECT MAX(c.`updated_at`)
            FROM `chapter` c
            WHERE c.`novel_id` = OLD.`novel_id`
          ),
          0
        )
      ELSE `last_chapter_updated_at`
    END,
    `updated_at` = unixepoch()
  WHERE `novel_id` = OLD.`novel_id`;
END;
