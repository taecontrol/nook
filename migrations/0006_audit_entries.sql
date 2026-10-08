CREATE TABLE audit_entries (
  id TEXT PRIMARY KEY NOT NULL,
  at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('delivered', 'denied')),
  path TEXT NOT NULL,
  purpose TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  machine_name TEXT NOT NULL,
  working_directory TEXT NOT NULL,
  executable TEXT NOT NULL,
  run_id TEXT NOT NULL
);
CREATE INDEX audit_entries_chronology ON audit_entries(at DESC, id DESC);
CREATE INDEX audit_entries_secret ON audit_entries(path, at DESC, id DESC);
