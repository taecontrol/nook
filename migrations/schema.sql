CREATE TABLE buckets (path TEXT PRIMARY KEY NOT NULL, created_at TEXT NOT NULL);
CREATE TRIGGER buckets_reserve_me BEFORE DELETE ON buckets WHEN OLD.path = 'me' BEGIN SELECT RAISE(ABORT, 'The me bucket cannot be deleted.'); END;
