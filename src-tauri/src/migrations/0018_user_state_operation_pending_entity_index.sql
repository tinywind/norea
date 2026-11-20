-- Index user-state operations by namespace, status, and entity key so ledger status queries avoid scanning all pending operations per intent.
CREATE INDEX user_state_operation_pending_entity_idx
  ON user_state_operation(namespace, status, entity_key);
