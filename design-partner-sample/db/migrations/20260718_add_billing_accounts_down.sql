-- Rollback migration: billing accounts
DROP INDEX IF EXISTS idx_billing_accounts_user;
DROP TABLE IF EXISTS billing_accounts;
