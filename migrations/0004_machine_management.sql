ALTER TABLE machine_tokens ADD COLUMN id TEXT;
UPDATE machine_tokens SET id = lower(hex(randomblob(16)));
CREATE UNIQUE INDEX machine_tokens_id ON machine_tokens(id);
ALTER TABLE machine_tokens ADD COLUMN last_used_at INTEGER;
-- The previous Worker can still issue tokens between migration and deployment.
CREATE TRIGGER machine_tokens_assign_id AFTER INSERT ON machine_tokens
WHEN NEW.id IS NULL
BEGIN
  UPDATE machine_tokens SET id = lower(hex(randomblob(16)))
  WHERE token_hash = NEW.token_hash;
END;
