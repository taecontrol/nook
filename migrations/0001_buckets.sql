CREATE TABLE buckets (
  path TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO buckets (path, created_at) VALUES ('me', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
