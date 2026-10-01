ALTER TABLE source_policies ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'live';
ALTER TABLE source_policies ADD COLUMN implementation_status TEXT NOT NULL DEFAULT 'unavailable';
ALTER TABLE source_policies ADD COLUMN settings_mutable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE source_policies ADD COLUMN simulation_behavior TEXT;
ALTER TABLE source_policies ADD COLUMN unit_cost_cents INTEGER NOT NULL DEFAULT 0;

ALTER TABLE research_runs ADD COLUMN current_stage TEXT NOT NULL DEFAULT 'created';
ALTER TABLE research_runs ADD COLUMN processed_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE run_sources (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES source_policies(id) ON DELETE RESTRICT,
  status TEXT NOT NULL,
  discovered_count INTEGER NOT NULL DEFAULT 0,
  processed_count INTEGER NOT NULL DEFAULT 0,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  error_note TEXT,
  started_at TEXT,
  completed_at TEXT,
  UNIQUE(run_id, source_id)
);

CREATE TABLE provider_usage (
  id INTEGER PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES source_policies(id) ON DELETE RESTRICT,
  run_id INTEGER NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_run_sources_run ON run_sources(run_id, id);
CREATE INDEX idx_provider_usage_provider ON provider_usage(provider_id, created_at DESC);

UPDATE source_policies
SET source_kind = 'owner_input', implementation_status = 'available', settings_mutable = 0
WHERE id = 'manual_public';

UPDATE source_policies
SET source_kind = 'live', implementation_status = 'deferred', settings_mutable = 0, enabled = 0
WHERE id IN ('public_web', 'public_repo_docs', 'protected_sources');

INSERT OR IGNORE INTO source_policies
  (id, name, description, discover_allowed, read_allowed, store_allowed, contact_allowed, automate_allowed,
   enabled, paid, policy_note, updated_at, source_kind, implementation_status, settings_mutable, simulation_behavior, unit_cost_cents)
VALUES
  ('simulated_public', 'Simulated public conversations', 'Realistic fictional public posts used to prove automatic discovery and ranking without internet access.', 1, 1, 1, 0, 1, 1, 0, 'Simulation only. Every result is labelled fictional and no external page is read.', CURRENT_TIMESTAMP, 'simulation', 'available', 1, 'success', 0),
  ('simulated_slow', 'Slow simulated community', 'A deliberately slow fictional source for checking live progress and partial results.', 1, 1, 1, 0, 1, 1, 0, 'Simulation only. Work is saved after each candidate so progress can be inspected.', CURRENT_TIMESTAMP, 'simulation', 'available', 1, 'slow', 0),
  ('simulated_failure', 'Failing simulated forum', 'A fictional source that returns some evidence and then fails for recovery testing.', 1, 1, 1, 0, 1, 1, 0, 'Simulation only. The planned failure must preserve earlier permitted results.', CURRENT_TIMESTAMP, 'simulation', 'available', 1, 'failure', 0),
  ('simulated_disabled', 'Disabled-source simulation', 'A fictional source kept off by default to verify immediate source disable controls.', 1, 1, 1, 0, 1, 0, 0, 'Simulation only. It cannot be used while disabled.', CURRENT_TIMESTAMP, 'simulation', 'available', 1, 'success', 0),
  ('simulated_paid', 'Paid-provider simulation', 'A fictional metered provider used to test approval, usage, and monthly spending stops.', 1, 1, 1, 0, 1, 0, 1, 'Simulation only. Approval and a positive monthly cap are required before use.', CURRENT_TIMESTAMP, 'simulation', 'available', 1, 'paid', 25);

INSERT OR IGNORE INTO provider_budgets
  (provider_id, approved_monthly_cents, spent_monthly_cents, enabled, updated_at)
VALUES ('simulated_paid', NULL, 0, 0, CURRENT_TIMESTAMP);
