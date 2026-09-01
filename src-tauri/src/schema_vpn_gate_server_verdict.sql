CREATE TABLE IF NOT EXISTS vpn_gate_server_verdict (
  ip text PRIMARY KEY NOT NULL,
  verdict text NOT NULL,
  updated_at integer DEFAULT (unixepoch()) NOT NULL,
  CONSTRAINT vpn_gate_server_verdict_verdict_check
    CHECK (verdict IN ('works', 'fails'))
);
