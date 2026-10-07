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
