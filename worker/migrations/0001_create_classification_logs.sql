CREATE TABLE IF NOT EXISTS classification_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  video_key TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT '',
  description_prefix TEXT NOT NULL DEFAULT '',
  client_version TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  confidence REAL,
  prob_study REAL,
  prob_entertainment REAL,
  prob_other REAL,
  jev_latency_ms INTEGER,
  error TEXT,
  http_status INTEGER NOT NULL DEFAULT 200
);
CREATE INDEX IF NOT EXISTS idx_classification_logs_id_desc ON classification_logs (id DESC);
CREATE INDEX IF NOT EXISTS idx_classification_logs_video_key ON classification_logs (video_key);
CREATE INDEX IF NOT EXISTS idx_classification_logs_category ON classification_logs (category);
