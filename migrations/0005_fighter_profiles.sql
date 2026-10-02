CREATE TABLE fighter_profile_cache (
  id TEXT PRIMARY KEY,
  payload_json TEXT,
  fetched_at INTEGER NOT NULL DEFAULT 0,
  refresh_after INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT
);
CREATE TABLE fighter_profile_usage (
  month TEXT PRIMARY KEY,
  requests INTEGER NOT NULL DEFAULT 0
);
