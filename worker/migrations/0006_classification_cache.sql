CREATE TABLE IF NOT EXISTS classification_cache (
  video_key TEXT PRIMARY KEY,
  url TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0,
  prob_study REAL NOT NULL DEFAULT 0,
  prob_entertainment REAL NOT NULL DEFAULT 0,
  prob_other REAL NOT NULL DEFAULT 0,
  policy_version TEXT NOT NULL DEFAULT '1',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_classification_cache_policy_updated
  ON classification_cache (policy_version, updated_at);
