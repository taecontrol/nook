CREATE UNIQUE INDEX machine_tokens_id ON machine_tokens(id);
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
CREATE TABLE buckets (path TEXT PRIMARY KEY NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE machine_tokens (
  token_hash TEXT PRIMARY KEY NOT NULL,
  machine_name TEXT NOT NULL,
  grant_json TEXT NOT NULL,
  created_at INTEGER NOT NULL , id TEXT, last_used_at INTEGER
);
CREATE TABLE secrets (
  bucket TEXT NOT NULL REFERENCES buckets(path) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL,
  key_id TEXT NOT NULL CHECK (length(key_id) = 16 AND key_id NOT GLOB '*[^0-9a-f]*'),
  iv TEXT NOT NULL CHECK (length(iv) = 16),
  ciphertext TEXT NOT NULL CHECK (length(ciphertext) BETWEEN 23 AND 87404),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (bucket, name)
) WITHOUT ROWID;
CREATE TRIGGER buckets_reserve_me BEFORE DELETE ON buckets WHEN OLD.path = 'me' BEGIN SELECT RAISE(ABORT, 'The me bucket cannot be deleted.'); END;
CREATE TRIGGER machine_tokens_assign_id AFTER INSERT ON machine_tokens WHEN NEW.id IS NULL BEGIN UPDATE machine_tokens SET id = lower(hex(randomblob(16))) WHERE token_hash = NEW.token_hash; END;
