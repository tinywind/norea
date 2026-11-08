-- Personal state is a merge journal. It never contains files, credentials, or device settings.
CREATE TABLE user_state_workspace (
  server_url TEXT PRIMARY KEY NOT NULL,
  namespace TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0,
  read_through INTEGER,
  last_success_at INTEGER
);
CREATE TABLE user_state_intent (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_key TEXT NOT NULL UNIQUE,
  entity_json TEXT NOT NULL,
  value_json TEXT NOT NULL,
  seed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE user_state_progress (
  namespace TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  local_sequence INTEGER NOT NULL DEFAULT 0,
  acknowledged_sequence INTEGER NOT NULL DEFAULT 0,
  base_revision INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(namespace, entity_key)
);
CREATE TABLE user_state_operation (
  operation_id TEXT PRIMARY KEY NOT NULL,
  namespace TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  intent_sequence INTEGER NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  receipt TEXT
);
CREATE INDEX user_state_operation_pending_idx ON user_state_operation(namespace,status,intent_sequence);
CREATE TABLE user_state_record (
  namespace TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  payload TEXT NOT NULL,
  applied_revision INTEGER NOT NULL DEFAULT 0,
  deletion_revision INTEGER NOT NULL DEFAULT 0,
  deferred_reason TEXT,
  deferred_detail TEXT,
  PRIMARY KEY(namespace,entity_key)
);
CREATE TABLE user_state_conflict (
  id TEXT PRIMARY KEY NOT NULL,
  namespace TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  reason TEXT NOT NULL
);
CREATE UNIQUE INDEX user_state_conflict_entity_idx ON user_state_conflict(namespace,entity_key);
CREATE TABLE user_state_category (
  category_id TEXT PRIMARY KEY NOT NULL,
  local_id INTEGER REFERENCES category(id) ON DELETE SET NULL
);
CREATE INDEX user_state_category_local_idx ON user_state_category(local_id);
CREATE TABLE user_state_alias (
  namespace TEXT NOT NULL,
  alias_id TEXT NOT NULL,
  canonical_id TEXT NOT NULL,
  PRIMARY KEY(namespace,alias_id)
);
CREATE TABLE user_state_private (entity_key TEXT PRIMARY KEY NOT NULL, public_value_json TEXT NOT NULL);
CREATE TABLE user_state_restore_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  paused INTEGER NOT NULL DEFAULT 0,
  restored INTEGER NOT NULL DEFAULT 0
);
INSERT INTO user_state_restore_state(id,paused,restored) VALUES(1,0,0);
