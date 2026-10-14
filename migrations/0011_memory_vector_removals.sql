-- Pending removal of a derived vector; never content, bucket or provenance.
CREATE TABLE memory_vector_removals (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  forgotten_at TEXT NOT NULL
);
CREATE INDEX memory_vector_removals_age ON memory_vector_removals(forgotten_at, id);
