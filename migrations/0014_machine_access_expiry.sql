ALTER TABLE authorizations ADD COLUMN access_expires_at INTEGER;
ALTER TABLE machine_tokens ADD COLUMN access_expires_at INTEGER;
-- An expired token can never record a use, whichever Worker build asks:
-- authentication is this UPDATE … RETURNING, so an ignored row reads as revoked.
-- NULL means the access never expires (every row from before this migration).
CREATE TRIGGER machine_tokens_expired_unused BEFORE UPDATE OF last_used_at ON machine_tokens
WHEN OLD.access_expires_at IS NOT NULL
  AND OLD.access_expires_at <= unixepoch('subsec')*1000
BEGIN
  SELECT RAISE(IGNORE);
END;
