UPDATE vpn_download_plan
SET payload = json_set(payload, '$.batchId', COALESCE((
    SELECT CASE
        WHEN count(*) > 0
            AND count(DISTINCT json_extract(job_json, '$.batchId')) = 1
            AND sum(CASE WHEN json_type(job_json, '$.batchId') = 'text'
                AND length(trim(json_extract(job_json, '$.batchId'))) > 0 THEN 0 ELSE 1 END) = 0
        THEN min(json_extract(job_json, '$.batchId')) END
    FROM chapter_download_queue
    WHERE CASE WHEN json_valid(job_json) THEN
        json_extract(job_json, '$.vpnPlanId') = vpn_download_plan.id
        AND json_extract(job_json, '$.id') = chapter_id ELSE 0 END
), 'legacy-vpn-plan:' || id))
WHERE CASE WHEN json_valid(payload) THEN json_type(payload, '$.batchId') IS NULL ELSE 0 END;

CREATE TABLE vpn_download_profile_issue (
    batch_id text NOT NULL,
    ip text NOT NULL,
    profile_id text NOT NULL,
    profile_hash text NOT NULL,
    plan_id text NOT NULL,
    range_id text NOT NULL,
    generation integer NOT NULL CHECK (generation >= 0),
    cause text NOT NULL CHECK (cause IN ('captcha', 'cloudflare', 'connection-failed', 'authentication-required', 'tunnel-lost')),
    recorded_at integer NOT NULL CHECK (recorded_at >= 0),
    excluded integer NOT NULL CHECK (excluded IN (0, 1)),
    revision integer NOT NULL CHECK (revision > 0),
    PRIMARY KEY (batch_id, ip)
);
