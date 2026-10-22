CREATE INDEX audit_entries_bucket ON audit_entries(bucket, at DESC, id DESC);
CREATE INDEX audit_entries_chronology ON audit_entries(at DESC, id DESC);
CREATE INDEX audit_entries_secret ON audit_entries(path, at DESC, id DESC);
CREATE UNIQUE INDEX machine_tokens_id ON machine_tokens(id);
CREATE UNIQUE INDEX memories_current_content ON memories(bucket, content_hash);
CREATE INDEX memories_feed ON memories(bucket, created_at DESC, id DESC);
CREATE INDEX memory_vector_removals_age ON memory_vector_removals(forgotten_at, id);
CREATE TABLE "audit_entries" (
  id TEXT PRIMARY KEY NOT NULL,
  at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('delivered', 'denied', 'created', 'revealed', 'file_attached', 'file_replaced', 'file_downloaded', 'file_detached', 'file_forgotten')),
  path TEXT,
  purpose TEXT,
  machine_id TEXT,
  machine_name TEXT,
  working_directory TEXT,
  executable TEXT,
  run_id TEXT,
  ip TEXT,
  country TEXT,
  bucket TEXT,
  memory_id TEXT,
  file_name TEXT,
  file_size INTEGER,
  file_sha256 TEXT,
  replaced_sha256 TEXT,
  client_name TEXT,
  client_version TEXT,
  CHECK (
    (path IS NOT NULL AND purpose IS NOT NULL
      AND memory_id IS NULL AND file_name IS NULL AND file_size IS NULL
      AND file_sha256 IS NULL AND replaced_sha256 IS NULL
      AND client_name IS NULL AND client_version IS NULL
      AND (
        (outcome = 'revealed' AND machine_id IS NULL AND machine_name IS NULL AND working_directory IS NULL AND executable IS NULL AND run_id IS NULL)
        OR (outcome = 'created' AND machine_id IS NOT NULL AND machine_name IS NOT NULL AND working_directory IS NOT NULL AND executable IS NULL AND run_id IS NULL AND ip IS NULL AND country IS NULL)
        OR (outcome IN ('delivered', 'denied') AND machine_id IS NOT NULL AND machine_name IS NOT NULL AND working_directory IS NOT NULL AND executable IS NOT NULL AND run_id IS NOT NULL AND ip IS NULL AND country IS NULL)
      ))
    OR (outcome IN ('file_attached', 'file_replaced', 'file_downloaded', 'file_detached', 'file_forgotten')
      AND path IS NULL AND purpose IS NULL
      AND bucket IS NOT NULL AND length(bucket)>0
      AND memory_id IS NOT NULL AND length(memory_id)=36
      AND file_name IS NOT NULL AND length(CAST(file_name AS BLOB)) BETWEEN 1 AND 255
      AND instr(file_name,'/')=0 AND instr(file_name,'\')=0 AND file_name NOT IN ('.','..')
      AND file_size IS NOT NULL AND file_size BETWEEN 0 AND 26214400
      AND file_sha256 IS NOT NULL AND length(file_sha256)=64 AND file_sha256 NOT GLOB '*[^0-9a-f]*'
      AND ((outcome='file_replaced' AND replaced_sha256 IS NOT NULL AND length(replaced_sha256)=64 AND replaced_sha256 NOT GLOB '*[^0-9a-f]*')
        OR (outcome<>'file_replaced' AND replaced_sha256 IS NULL))
      AND client_name IS NOT NULL AND length(client_name) BETWEEN 1 AND 128
      AND (client_version IS NULL OR length(client_version) BETWEEN 1 AND 64)
      AND working_directory IS NULL AND executable IS NULL AND run_id IS NULL
      AND ((machine_id IS NOT NULL AND machine_name IS NOT NULL AND ip IS NULL AND country IS NULL)
        OR (machine_id IS NULL AND machine_name IS NULL)))
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
CREATE TABLE file_sweep (id INTEGER PRIMARY KEY CHECK (id=1), cursor TEXT, swept_at TEXT);
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
  updated_at TEXT NOT NULL , embedding_marker TEXT
);
CREATE VIRTUAL TABLE memories_fts USING fts5(content, tags, content='memory_current', content_rowid='seq', tokenize='unicode61 remove_diacritics 2');
CREATE TABLE 'memories_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID;
CREATE TABLE 'memories_fts_data'(id INTEGER PRIMARY KEY, block BLOB);
CREATE TABLE 'memories_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB);
CREATE TABLE 'memories_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;
CREATE TABLE memory_files (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(CAST(name AS BLOB)) BETWEEN 1 AND 255
    AND instr(name,'/')=0 AND instr(name,'\')=0 AND name NOT IN ('.','..')),
  object_key TEXT NOT NULL UNIQUE,
  media_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size BETWEEN 0 AND 26214400),
  sha256 TEXT NOT NULL CHECK (length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  principal TEXT NOT NULL CHECK (principal IN ('machine','owner')),
  machine_id TEXT,
  machine_name TEXT,
  client_name TEXT NOT NULL CHECK (length(client_name) BETWEEN 1 AND 128),
  client_version TEXT CHECK (client_version IS NULL OR length(client_version) BETWEEN 1 AND 64),
  attached_at TEXT NOT NULL,
  CHECK ((principal='machine' AND machine_id IS NOT NULL AND machine_name IS NOT NULL)
      OR (principal='owner' AND machine_id IS NULL AND machine_name IS NULL)),
  PRIMARY KEY (memory_id, name)
) WITHOUT ROWID;
CREATE TABLE memory_vector_removals (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  forgotten_at TEXT NOT NULL
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
CREATE TRIGGER audit_entries_assign_bucket AFTER INSERT ON audit_entries WHEN NEW.bucket IS NULL AND NEW.path IS NOT NULL BEGIN
  UPDATE audit_entries SET bucket=substr(NEW.path,1,length(NEW.path)-length(json_extract('["' || replace(NEW.path,'/','","') || '"]','$[#-1]'))-1) WHERE id=NEW.id;
END;
CREATE TRIGGER buckets_reserve_me BEFORE DELETE ON buckets WHEN OLD.path = 'me' BEGIN SELECT RAISE(ABORT, 'The me bucket cannot be deleted.'); END;
CREATE TRIGGER machine_tokens_assign_id AFTER INSERT ON machine_tokens WHEN NEW.id IS NULL BEGIN UPDATE machine_tokens SET id = lower(hex(randomblob(16))) WHERE token_hash = NEW.token_hash; END;
CREATE TRIGGER memories_fts_current_update AFTER UPDATE OF current_version ON memories BEGIN INSERT INTO memories_fts(memories_fts, rowid, content, tags) SELECT 'delete', OLD.seq, content, tags FROM memory_versions WHERE memory_id = OLD.id AND version = OLD.current_version; INSERT INTO memories_fts(rowid, content, tags) SELECT NEW.seq, content, tags FROM memory_versions WHERE memory_id = NEW.id AND version = NEW.current_version; END;
CREATE TRIGGER memories_fts_delete BEFORE DELETE ON memories BEGIN INSERT INTO memories_fts(memories_fts, rowid, content, tags) SELECT 'delete', OLD.seq, content, tags FROM memory_versions WHERE memory_id = OLD.id AND version = OLD.current_version; END;
CREATE TRIGGER memories_fts_version_insert AFTER INSERT ON memory_versions WHEN NEW.version = (SELECT current_version FROM memories WHERE id = NEW.memory_id) BEGIN INSERT INTO memories_fts(rowid, content, tags) SELECT seq, NEW.content, NEW.tags FROM memories WHERE id = NEW.memory_id; END;
CREATE VIEW memory_current AS SELECT m.seq, v.content, v.tags FROM memories m JOIN memory_versions v ON v.memory_id = m.id AND v.version = m.current_version;
