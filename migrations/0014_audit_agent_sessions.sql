ALTER TABLE audit_entries ADD COLUMN agent TEXT CHECK (agent IS NULL OR (
  outcome IN ('delivered','denied','created')
  AND length(agent) BETWEEN 1 AND 32 AND agent NOT GLOB '*[^a-z0-9-]*'));
ALTER TABLE audit_entries ADD COLUMN agent_session TEXT CHECK (
  (agent IS NULL) = (agent_session IS NULL)
  AND (agent_session IS NULL OR (length(agent_session) BETWEEN 1 AND 200
       AND agent_session NOT GLOB '*[^A-Za-z0-9._:~-]*')));
ALTER TABLE audit_entries ADD COLUMN agent_thread TEXT CHECK (agent_thread IS NULL OR (
  agent_session IS NOT NULL AND agent_thread <> agent_session
  AND length(agent_thread) BETWEEN 1 AND 200 AND agent_thread NOT GLOB '*[^A-Za-z0-9._:~-]*'));
CREATE INDEX audit_entries_agent_session
  ON audit_entries(agent_session, at DESC, id DESC) WHERE agent_session IS NOT NULL;
