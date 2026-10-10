CREATE TABLE memories (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE CHECK (length(id) = 36),
  bucket TEXT NOT NULL REFERENCES buckets(path) ON DELETE RESTRICT,
  current_version INTEGER NOT NULL CHECK (current_version >= 1),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX memories_current_content ON memories(bucket, content_hash);
CREATE INDEX memories_feed ON memories(bucket, created_at DESC, id DESC);
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
