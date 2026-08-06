-- Forward migration: billing accounts (design-partner migration wedge)
CREATE TABLE IF NOT EXISTS billing_accounts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  plan TEXT NOT NULL DEFAULT 'free',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_billing_accounts_user
  ON billing_accounts(user_id);
