-- Track acknowledgement timestamps so retained user-state operation receipts can be pruned safely.
ALTER TABLE user_state_operation ADD COLUMN acknowledged_at INTEGER CHECK (acknowledged_at IS NULL OR acknowledged_at >= 0);

UPDATE user_state_operation
SET acknowledged_at = unixepoch()
WHERE status = 'acknowledged' AND acknowledged_at IS NULL;

CREATE INDEX user_state_operation_acknowledged_idx
  ON user_state_operation(namespace, status, acknowledged_at);
