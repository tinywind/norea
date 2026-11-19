-- Track per-workspace seed suppression (Mode B start fresh) and sliding-window seed cutoff.
ALTER TABLE user_state_workspace
  ADD COLUMN seed_suppressed INTEGER NOT NULL DEFAULT 0 CHECK (seed_suppressed IN (0, 1));

ALTER TABLE user_state_workspace
  ADD COLUMN seed_cutoff_at INTEGER CHECK (seed_cutoff_at IS NULL OR seed_cutoff_at >= 0);
