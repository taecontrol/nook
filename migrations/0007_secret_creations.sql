CREATE TABLE audit_entries_new (
  id TEXT PRIMARY KEY NOT NULL,
  at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('delivered', 'denied', 'created')),
  path TEXT NOT NULL,
  purpose TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  machine_name TEXT NOT NULL,
  working_directory TEXT NOT NULL,
  executable TEXT,
  run_id TEXT,
  CHECK ((outcome = 'created' AND executable IS NULL AND run_id IS NULL)
    OR (outcome IN ('delivered', 'denied') AND executable IS NOT NULL AND run_id IS NOT NULL))
);
INSERT INTO audit_entries_new SELECT * FROM audit_entries;
DROP TABLE audit_entries;
ALTER TABLE audit_entries_new RENAME TO audit_entries;
CREATE INDEX audit_entries_chronology ON audit_entries(at DESC, id DESC);
CREATE INDEX audit_entries_secret ON audit_entries(path, at DESC, id DESC);
