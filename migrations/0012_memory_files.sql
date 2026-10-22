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
CREATE TABLE file_sweep (id INTEGER PRIMARY KEY CHECK (id=1), cursor TEXT, swept_at TEXT);
