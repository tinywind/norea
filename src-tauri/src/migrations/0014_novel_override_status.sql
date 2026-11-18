-- Upgrade legacy completed override flags to canonical status values without discarding other fields.
UPDATE novel_override
SET payload = json_set(
  json_remove(payload, '$.fields.completed'),
  '$.fields.status',
  json_object(
    'value',
    CASE json_type(payload, '$.fields.completed.value')
      WHEN 'true' THEN 'Completed'
      WHEN 'false' THEN 'Ongoing'
      ELSE NULL
    END,
    'updatedAt',
    json_extract(payload, '$.fields.completed.updatedAt')
  )
)
WHERE json_type(payload, '$.fields.completed') IS NOT NULL
  AND (
    json_type(payload, '$.fields.status') IS NULL
    OR json_extract(payload, '$.fields.completed.updatedAt') > json_extract(payload, '$.fields.status.updatedAt')
  );

UPDATE novel_override
SET payload = json_remove(payload, '$.fields.completed')
WHERE json_type(payload, '$.fields.completed') IS NOT NULL;
