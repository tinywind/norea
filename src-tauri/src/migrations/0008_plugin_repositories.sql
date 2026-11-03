DROP INDEX repository_singleton_uniq;

ALTER TABLE repository ADD COLUMN priority integer DEFAULT 1 NOT NULL CHECK (priority >= 1);

ALTER TABLE repository ADD COLUMN enabled integer DEFAULT 1 NOT NULL CHECK (enabled IN (0, 1));

ALTER TABLE installed_plugin ADD COLUMN repository_url text;

UPDATE installed_plugin
SET repository_url = (
    SELECT repository.url
    FROM repository
    JOIN repository_index_cache ON repository_index_cache.repo_url = repository.url
    JOIN json_each(
        CASE WHEN json_valid(repository_index_cache.items_json)
        THEN CASE WHEN json_type(repository_index_cache.items_json) = 'array'
            THEN repository_index_cache.items_json END
        END
    ) AS entry
    WHERE CASE WHEN entry.type = 'object'
        THEN json_extract(entry.value, '$.url') END = installed_plugin.source_url
    ORDER BY repository.id
    LIMIT 1
);
