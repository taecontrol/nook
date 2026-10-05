CREATE TABLE authorizations (
  device_hash TEXT PRIMARY KEY NOT NULL,
  user_code TEXT NOT NULL UNIQUE,
  suggested_name TEXT NOT NULL,
  client TEXT NOT NULL,
  machine_name TEXT,
  grant_json TEXT NOT NULL DEFAULT '"all"',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  requested_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE machine_tokens (
  token_hash TEXT PRIMARY KEY NOT NULL,
  machine_name TEXT NOT NULL,
  grant_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
