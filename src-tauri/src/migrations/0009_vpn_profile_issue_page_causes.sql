CREATE TABLE vpn_download_profile_issue_v9 (
    batch_id text NOT NULL,
    ip text NOT NULL,
    profile_id text NOT NULL,
    profile_hash text NOT NULL,
    plan_id text NOT NULL,
    range_id text NOT NULL,
    generation integer NOT NULL CHECK (generation >= 0),
    cause text NOT NULL CHECK (cause IN ('captcha', 'cloudflare', 'connection-failed', 'authentication-required', 'tunnel-lost', 'page-unresponsive', 'site-forbidden')),
    recorded_at integer NOT NULL CHECK (recorded_at >= 0),
    excluded integer NOT NULL CHECK (excluded IN (0, 1)),
    revision integer NOT NULL CHECK (revision > 0),
    PRIMARY KEY (batch_id, ip)
);

INSERT INTO vpn_download_profile_issue_v9
    (batch_id, ip, profile_id, profile_hash, plan_id, range_id, generation, cause, recorded_at, excluded, revision)
SELECT batch_id, ip, profile_id, profile_hash, plan_id, range_id, generation, cause, recorded_at, excluded, revision
FROM vpn_download_profile_issue;

DROP TABLE vpn_download_profile_issue;

ALTER TABLE vpn_download_profile_issue_v9 RENAME TO vpn_download_profile_issue;
