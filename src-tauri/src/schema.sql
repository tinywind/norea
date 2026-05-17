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
  `content` text,
  `content_type` text DEFAULT 'html' NOT NULL,
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
