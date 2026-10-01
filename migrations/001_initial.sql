CREATE TABLE owners (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  website_url TEXT,
  repository_url TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE materials (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  source_url TEXT,
  content TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE evidence (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  material_id INTEGER REFERENCES materials(id) ON DELETE SET NULL,
  source_type TEXT NOT NULL,
  source_url TEXT,
  title TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  captured_at TEXT NOT NULL
);

CREATE TABLE profile_versions (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(product_id, version)
);

CREATE TABLE profile_statements (
  id INTEGER PRIMARY KEY,
  profile_version_id INTEGER NOT NULL REFERENCES profile_versions(id) ON DELETE CASCADE,
  section TEXT NOT NULL,
  knowledge_state TEXT NOT NULL CHECK (knowledge_state IN ('known', 'hypothesis', 'needs_testing')),
  statement TEXT NOT NULL,
  evidence_id INTEGER REFERENCES evidence(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE discussion_messages (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'agent')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE source_policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  discover_allowed INTEGER NOT NULL DEFAULT 0,
  read_allowed INTEGER NOT NULL DEFAULT 0,
  store_allowed INTEGER NOT NULL DEFAULT 0,
  contact_allowed INTEGER NOT NULL DEFAULT 0,
  automate_allowed INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 0,
  paid INTEGER NOT NULL DEFAULT 0,
  policy_note TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE provider_budgets (
  provider_id TEXT PRIMARY KEY,
  approved_monthly_cents INTEGER,
  spent_monthly_cents INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE experiments (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  audience TEXT NOT NULL,
  signal TEXT NOT NULL,
  success_criteria TEXT NOT NULL,
  allowed_source_ids TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE research_runs (
  id INTEGER PRIMARY KEY,
  experiment_id INTEGER NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  input_count INTEGER NOT NULL DEFAULT 0,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  progress_note TEXT NOT NULL,
  error_note TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE run_events (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE rejected_candidates (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  identity_label TEXT NOT NULL,
  source_url TEXT,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE opportunities (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  person_name TEXT,
  company_name TEXT,
  signal TEXT NOT NULL,
  evidence_id INTEGER NOT NULL REFERENCES evidence(id) ON DELETE RESTRICT,
  why_signal_matters TEXT NOT NULL,
  product_fit TEXT NOT NULL,
  intent_strength TEXT NOT NULL,
  intent_reason TEXT NOT NULL,
  disqualifiers TEXT,
  recommended_action TEXT NOT NULL,
  action_reason TEXT NOT NULL,
  personalization_context TEXT,
  confidence INTEGER NOT NULL,
  score INTEGER NOT NULL,
  rank INTEGER NOT NULL,
  original_reasoning TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE drafts (
  id INTEGER PRIMARY KEY,
  opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_approval',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE feedback (
  id INTEGER PRIMARY KEY,
  opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  rating TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE outcomes (
  id INTEGER PRIMARY KEY,
  opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE learnings (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  experiment_id INTEGER REFERENCES experiments(id) ON DELETE SET NULL,
  statement TEXT NOT NULL,
  basis TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_materials_product ON materials(product_id);
CREATE INDEX idx_evidence_product ON evidence(product_id);
CREATE INDEX idx_profiles_product ON profile_versions(product_id, version DESC);
CREATE INDEX idx_experiments_product ON experiments(product_id, created_at DESC);
CREATE INDEX idx_opportunities_product ON opportunities(product_id, score DESC);
CREATE INDEX idx_learnings_product ON learnings(product_id, created_at DESC);

INSERT INTO source_policies VALUES
  ('manual_public', 'Owner-provided public evidence', 'Public pages the owner has reviewed and deliberately adds to a bounded run.', 1, 1, 1, 0, 0, 1, 0, 'Store only the excerpt needed to evaluate the signal; never contact automatically.', CURRENT_TIMESTAMP),
  ('public_web', 'Compliant web search', 'Broad public-web discovery through an approved search provider.', 1, 1, 1, 0, 0, 0, 1, 'Disabled until a provider, credentials, terms review, and monthly spend cap are approved.', CURRENT_TIMESTAMP),
  ('public_repo_docs', 'Public repository documentation', 'Read-only product documentation from a public repository.', 1, 1, 1, 0, 0, 0, 0, 'Read documentation only. Never modify repositories, settings, pull requests, or deployments.', CURRENT_TIMESTAMP),
  ('protected_sources', 'Protected or unclear sources', 'Sources whose access or automation rules are protected or unclear.', 0, 0, 0, 0, 0, 0, 0, 'Denied by default. Do not bypass access controls or platform restrictions.', CURRENT_TIMESTAMP);
