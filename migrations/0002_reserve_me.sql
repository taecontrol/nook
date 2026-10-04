CREATE TRIGGER buckets_reserve_me
BEFORE DELETE ON buckets
WHEN OLD.path = 'me'
BEGIN
  SELECT RAISE(ABORT, 'The me bucket cannot be deleted.');
END;
