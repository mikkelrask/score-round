CREATE TABLE official_fight_cache (
  id TEXT PRIMARY KEY,
  payload_json TEXT,
  refresh_after INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT
);
