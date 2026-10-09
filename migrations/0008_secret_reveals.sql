CREATE TABLE audit_entries_new (
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
INSERT INTO audit_entries_new (id, at, outcome, path, purpose, machine_id, machine_name, working_directory, executable, run_id)
  SELECT id, at, outcome, path, purpose, machine_id, machine_name, working_directory, executable, run_id FROM audit_entries;
DROP TABLE audit_entries;
ALTER TABLE audit_entries_new RENAME TO audit_entries;
CREATE INDEX audit_entries_chronology ON audit_entries(at DESC, id DESC);
CREATE INDEX audit_entries_secret ON audit_entries(path, at DESC, id DESC);
