CREATE TABLE IF NOT EXISTS `download_cache_work` (
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
CREATE INDEX IF NOT EXISTS `download_cache_work_status_idx`
ON `download_cache_work` (`status`, `updated_at_ms`);
