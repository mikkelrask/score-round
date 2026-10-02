CREATE TABLE fight_schedule_cache (
  id TEXT PRIMARY KEY,
  payload_json TEXT,
  fetched_at INTEGER NOT NULL DEFAULT 0,
  refresh_after INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  requests_remaining INTEGER,
  quota_reset_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE fight_schedule_usage (
  month TEXT PRIMARY KEY,
  requests INTEGER NOT NULL DEFAULT 0
);
