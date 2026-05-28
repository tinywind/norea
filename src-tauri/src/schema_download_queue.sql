CREATE TABLE IF NOT EXISTS `chapter_download_queue` (
  `chapter_id` integer PRIMARY KEY NOT NULL,
  `job_json` text NOT NULL,
  `created_at_ms` integer NOT NULL,
  `updated_at_ms` integer NOT NULL,
  `leased_at_ms` integer,
  `attempt_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `chapter_download_queue_created_idx`
ON `chapter_download_queue` (`created_at_ms`, `chapter_id`);
