INSERT OR IGNORE INTO provider_budgets
  (provider_id, approved_monthly_cents, spent_monthly_cents, enabled, updated_at)
VALUES
  ('language_model', NULL, 0, 0, CURRENT_TIMESTAMP),
  ('public_web', NULL, 0, 0, CURRENT_TIMESTAMP);
