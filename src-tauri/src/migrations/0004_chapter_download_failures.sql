CREATE TABLE chapter_download_failure (
    chapter_id integer PRIMARY KEY NOT NULL REFERENCES chapter(id) ON UPDATE no action ON DELETE cascade,
    plugin_id text NOT NULL,
    failure_class text NOT NULL CHECK (failure_class IN ('transient', 'challenge', 'content', 'storage', 'media-incomplete')),
    message_summary text NOT NULL,
    challenge_url text,
    attempts integer NOT NULL CHECK (attempts > 0),
    next_retry_at integer CHECK (next_retry_at IS NULL OR next_retry_at >= 0),
    job_json text NOT NULL,
    updated_at integer NOT NULL CHECK (updated_at >= 0)
);

CREATE INDEX chapter_download_failure_source_idx
ON chapter_download_failure (plugin_id, failure_class);
