CREATE TABLE fighter_portraits (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  payload_json TEXT,
  refresh_after INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT
);
CREATE TABLE portrait_lookup_usage (
  day TEXT PRIMARY KEY,
  requests INTEGER NOT NULL DEFAULT 0
);
