CREATE TABLE IF NOT EXISTS override_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  video_key TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT '',
  client_version TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_override_logs_video_key ON override_logs (video_key);
