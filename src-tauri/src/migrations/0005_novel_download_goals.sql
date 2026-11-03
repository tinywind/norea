CREATE TABLE novel_download_goal (
    novel_id integer PRIMARY KEY NOT NULL REFERENCES novel(id) ON UPDATE no action ON DELETE cascade,
    kind text NOT NULL CHECK (kind IN ('keep_ahead', 'all_remaining', 'entire')),
    count integer CHECK ((kind = 'keep_ahead' AND count > 0) OR (kind <> 'keep_ahead' AND count IS NULL)),
    updated_at integer NOT NULL CHECK (updated_at >= 0)
);
