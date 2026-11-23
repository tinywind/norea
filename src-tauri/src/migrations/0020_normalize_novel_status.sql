-- Rewrite retired NovelStatus constants ('Unknown', 'Licensed', 'Publishing Finished')
-- to canonical 'Ongoing' in persisted novel rows and work overrides.
UPDATE novel
SET status = 'Ongoing'
WHERE trim(status) IN ('Unknown', 'Licensed', 'Publishing Finished');

UPDATE novel_override
SET payload = json_set(payload, '$.fields.status.value', 'Ongoing')
WHERE json_type(payload, '$.fields.status.value') = 'text'
  AND trim(json_extract(payload, '$.fields.status.value')) IN (
    'Unknown',
    'Licensed',
    'Publishing Finished'
  );
