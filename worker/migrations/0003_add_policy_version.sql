ALTER TABLE classification_logs ADD COLUMN policy_version TEXT NOT NULL DEFAULT '1';
CREATE INDEX IF NOT EXISTS idx_classification_logs_policy_version ON classification_logs (policy_version);
