ALTER TABLE chapter ADD COLUMN found_by_check integer DEFAULT 0 NOT NULL CHECK (found_by_check IN (0, 1));

CREATE INDEX chapter_found_by_check_idx
ON chapter (found_by_check, unread, found_at);

CREATE TABLE novel_freshness (
    novel_id integer PRIMARY KEY NOT NULL REFERENCES novel(id) ON UPDATE no action ON DELETE cascade,
    last_checked_at integer CHECK (last_checked_at IS NULL OR last_checked_at >= 0),
    last_success_at integer CHECK (last_success_at IS NULL OR last_success_at >= 0),
    consecutive_failures integer DEFAULT 0 NOT NULL CHECK (consecutive_failures >= 0),
    last_new_chapter_at integer CHECK (last_new_chapter_at IS NULL OR last_new_chapter_at >= 0),
    cover_fetched_at integer CHECK (cover_fetched_at IS NULL OR cover_fetched_at >= 0)
);
