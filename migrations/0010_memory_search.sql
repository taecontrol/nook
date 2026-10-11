ALTER TABLE memories ADD COLUMN embedding_marker TEXT;

CREATE VIEW memory_current AS
  SELECT m.seq, v.content, v.tags
  FROM memories m
  JOIN memory_versions v ON v.memory_id = m.id AND v.version = m.current_version;
CREATE VIRTUAL TABLE memories_fts USING fts5(
  content, tags,
  content='memory_current', content_rowid='seq',
  tokenize='unicode61 remove_diacritics 2'
);
-- Version rows are immutable. Editing or pruning them corrupts external-content FTS.
CREATE TRIGGER memories_fts_version_insert AFTER INSERT ON memory_versions
WHEN NEW.version = (SELECT current_version FROM memories WHERE id = NEW.memory_id)
BEGIN
  INSERT INTO memories_fts(rowid, content, tags)
    SELECT seq, NEW.content, NEW.tags FROM memories WHERE id = NEW.memory_id;
END;
CREATE TRIGGER memories_fts_current_update AFTER UPDATE OF current_version ON memories
BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags)
    SELECT 'delete', OLD.seq, content, tags FROM memory_versions WHERE memory_id = OLD.id AND version = OLD.current_version;
  INSERT INTO memories_fts(rowid, content, tags)
    SELECT NEW.seq, content, tags FROM memory_versions WHERE memory_id = NEW.id AND version = NEW.current_version;
END;
CREATE TRIGGER memories_fts_delete BEFORE DELETE ON memories
BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags)
    SELECT 'delete', OLD.seq, content, tags FROM memory_versions WHERE memory_id = OLD.id AND version = OLD.current_version;
END;
INSERT INTO memories_fts(memories_fts) VALUES ('rebuild');
