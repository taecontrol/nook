CREATE INDEX audit_entries_chronology ON audit_entries(at DESC, id DESC);
CREATE INDEX audit_entries_secret ON audit_entries(path, at DESC, id DESC);
CREATE UNIQUE INDEX machine_tokens_id ON machine_tokens(id);
CREATE UNIQUE INDEX memories_current_content ON memories(bucket, content_hash);
CREATE INDEX memories_feed ON memories(bucket, created_at DESC, id DESC);
CREATE TABLE "audit_entries" (
  id TEXT PRIMARY KEY NOT NULL,
  at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('delivered', 'denied', 'created', 'revealed')),
  path TEXT NOT NULL,
  purpose TEXT NOT NULL,
  machine_id TEXT,
  machine_name TEXT,
  working_directory TEXT,
  executable TEXT,
  run_id TEXT,
  ip TEXT,
  country TEXT,
  CHECK (
    (outcome = 'revealed' AND machine_id IS NULL AND machine_name IS NULL AND working_directory IS NULL AND executable IS NULL AND run_id IS NULL)
    OR (outcome = 'created' AND machine_id IS NOT NULL AND machine_name IS NOT NULL AND working_directory IS NOT NULL AND executable IS NULL AND run_id IS NULL AND ip IS NULL AND country IS NULL)
    OR (outcome IN ('delivered', 'denied') AND machine_id IS NOT NULL AND machine_name IS NOT NULL AND working_directory IS NOT NULL AND executable IS NOT NULL AND run_id IS NOT NULL AND ip IS NULL AND country IS NULL)
  )
);
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
CREATE TABLE memories (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE CHECK (length(id) = 36),
  bucket TEXT NOT NULL REFERENCES buckets(path) ON DELETE RESTRICT,
  current_version INTEGER NOT NULL CHECK (current_version >= 1),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE memory_versions (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  content TEXT NOT NULL CHECK (length(CAST(content AS BLOB)) BETWEEN 1 AND 16384),
  tags TEXT NOT NULL CHECK (json_valid(tags) AND json_type(tags) = 'array' AND json_array_length(tags) <= 10),
  client_name TEXT NOT NULL CHECK (length(client_name) BETWEEN 1 AND 128),
  client_version TEXT CHECK (client_version IS NULL OR length(client_version) BETWEEN 1 AND 64),
  principal TEXT NOT NULL CHECK (principal IN ('machine', 'owner')),
  machine_id TEXT,
  machine_name TEXT,
  working_directory TEXT,
  created_at TEXT NOT NULL,
  CHECK ((principal = 'machine' AND machine_id IS NOT NULL AND machine_name IS NOT NULL)
      OR (principal = 'owner' AND machine_id IS NULL AND machine_name IS NULL)),
  UNIQUE (memory_id, version)
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
