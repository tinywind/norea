CREATE TABLE novel_download_goal_v6 (
    novel_id integer PRIMARY KEY NOT NULL REFERENCES novel(id) ON UPDATE no action ON DELETE cascade,
    kind text NOT NULL CHECK (kind IN ('keep_ahead', 'all_remaining', 'entire', 'none')),
    count integer CHECK ((kind = 'keep_ahead' AND count > 0) OR (kind <> 'keep_ahead' AND count IS NULL)),
    updated_at integer NOT NULL CHECK (updated_at >= 0)
);

INSERT INTO novel_download_goal_v6 (novel_id, kind, count, updated_at)
SELECT novel_id, kind, count, updated_at FROM novel_download_goal;

DROP TABLE novel_download_goal;

ALTER TABLE novel_download_goal_v6 RENAME TO novel_download_goal;

CREATE TABLE chapter_download_goal_exclusion (
    chapter_id integer PRIMARY KEY NOT NULL REFERENCES chapter(id) ON UPDATE no action ON DELETE cascade,
    created_at integer NOT NULL CHECK (created_at >= 0)
);
