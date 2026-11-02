CREATE TABLE ask_first_marks (
  kind TEXT NOT NULL CHECK (kind IN ('bucket','secret')),
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec')*1000),
  PRIMARY KEY (kind,path)
) WITHOUT ROWID;
CREATE TABLE approval_requests (
  id TEXT PRIMARY KEY NOT NULL,
  machine_id TEXT NOT NULL,
  machine_name TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  agent TEXT CHECK (agent IS NULL OR (length(agent) BETWEEN 1 AND 32 AND agent NOT GLOB '*[^a-z0-9-]*')),
  agent_session TEXT CHECK ((agent IS NULL)=(agent_session IS NULL) AND (agent_session IS NULL OR (length(agent_session) BETWEEN 1 AND 200 AND agent_session NOT GLOB '*[^A-Za-z0-9._:~-]*'))),
  agent_thread TEXT CHECK (agent_thread IS NULL OR (agent_session IS NOT NULL AND agent_thread<>agent_session AND length(agent_thread) BETWEEN 1 AND 200 AND agent_thread NOT GLOB '*[^A-Za-z0-9._:~-]*')),
  secrets_json TEXT NOT NULL CHECK (json_valid(secrets_json) AND json_type(secrets_json)='array'),
  covered_json TEXT NOT NULL CHECK (json_valid(covered_json) AND json_type(covered_json)='array' AND json_array_length(covered_json) BETWEEN 1 AND 20),
  purpose TEXT NOT NULL,
  working_directory TEXT NOT NULL,
  executable TEXT NOT NULL,
  client TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','withdrawn','settled')),
  remember TEXT CHECK (remember IS NULL OR remember IN ('once','1h','12h')),
  requested_at INTEGER NOT NULL DEFAULT (unixepoch('subsec')*1000),
  expires_at INTEGER NOT NULL DEFAULT (unixepoch('subsec')*1000+600000),
  decided_at INTEGER,
  valid_until INTEGER,
  UNIQUE (machine_id,attempt_id),
  CHECK ((status='approved' AND remember IS NOT NULL AND decided_at IS NOT NULL AND valid_until IS NOT NULL)
    OR (status='denied' AND remember IS NULL AND decided_at IS NOT NULL AND valid_until IS NULL)
    OR (status IN ('pending','withdrawn','settled') AND remember IS NULL AND decided_at IS NULL AND valid_until IS NULL))
);
CREATE INDEX approval_requests_pending ON approval_requests(status,expires_at,machine_id);
CREATE INDEX approval_requests_remembered ON approval_requests(machine_id,status,valid_until) WHERE remember<>'once';

CREATE TABLE audit_entries_new (
  id TEXT PRIMARY KEY NOT NULL,
  at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('delivered', 'denied', 'created', 'revealed', 'file_attached', 'file_replaced', 'file_downloaded', 'file_detached', 'file_forgotten', 'approval_requested', 'approval_granted', 'approval_denied', 'approval_withdrawn', 'approval_refused')),
  path TEXT,
  purpose TEXT,
  machine_id TEXT,
  machine_name TEXT,
  working_directory TEXT,
  executable TEXT,
  run_id TEXT,
  ip TEXT,
  country TEXT,
  bucket TEXT,
  memory_id TEXT,
  file_name TEXT,
  file_size INTEGER,
  file_sha256 TEXT,
  replaced_sha256 TEXT,
  client_name TEXT,
  client_version TEXT,
  approval_id TEXT,
  approval_remember TEXT CHECK (approval_remember IS NULL OR approval_remember IN ('once','1h','12h')),
  agent TEXT CHECK (agent IS NULL OR (
    outcome IN ('delivered','denied','created')
    AND length(agent) BETWEEN 1 AND 32 AND agent NOT GLOB '*[^a-z0-9-]*')),
  agent_session TEXT CHECK (
    (agent IS NULL) = (agent_session IS NULL)
    AND (agent_session IS NULL OR (length(agent_session) BETWEEN 1 AND 200
         AND agent_session NOT GLOB '*[^A-Za-z0-9._:~-]*'))),
  agent_thread TEXT CHECK (agent_thread IS NULL OR (
    agent_session IS NOT NULL AND agent_thread <> agent_session
    AND length(agent_thread) BETWEEN 1 AND 200 AND agent_thread NOT GLOB '*[^A-Za-z0-9._:~-]*')),
  CHECK (
    (path IS NOT NULL AND purpose IS NOT NULL
      AND memory_id IS NULL AND file_name IS NULL AND file_size IS NULL
      AND file_sha256 IS NULL AND replaced_sha256 IS NULL
      AND client_name IS NULL AND client_version IS NULL
      AND (
        (outcome = 'revealed' AND machine_id IS NULL AND machine_name IS NULL AND working_directory IS NULL AND executable IS NULL AND run_id IS NULL)
        OR (outcome = 'created' AND machine_id IS NOT NULL AND machine_name IS NOT NULL AND working_directory IS NOT NULL AND executable IS NULL AND run_id IS NULL AND ip IS NULL AND country IS NULL)
        OR (outcome IN ('approval_requested','approval_granted','approval_denied','approval_withdrawn','approval_refused') AND machine_id IS NOT NULL AND machine_name IS NOT NULL AND working_directory IS NOT NULL AND executable IS NOT NULL AND run_id IS NOT NULL AND (outcome IN ('approval_granted','approval_denied') OR (ip IS NULL AND country IS NULL)))
        OR (outcome IN ('delivered', 'denied') AND machine_id IS NOT NULL AND machine_name IS NOT NULL AND working_directory IS NOT NULL AND executable IS NOT NULL AND run_id IS NOT NULL AND ip IS NULL AND country IS NULL)
      ))
    OR (outcome IN ('file_attached', 'file_replaced', 'file_downloaded', 'file_detached', 'file_forgotten')
      AND path IS NULL AND purpose IS NULL
      AND bucket IS NOT NULL AND length(bucket)>0
      AND memory_id IS NOT NULL AND length(memory_id)=36
      AND file_name IS NOT NULL AND length(CAST(file_name AS BLOB)) BETWEEN 1 AND 255
      AND instr(file_name,'/')=0 AND instr(file_name,'\')=0 AND file_name NOT IN ('.','..')
      AND file_size IS NOT NULL AND file_size BETWEEN 0 AND 26214400
      AND file_sha256 IS NOT NULL AND length(file_sha256)=64 AND file_sha256 NOT GLOB '*[^0-9a-f]*'
      AND ((outcome='file_replaced' AND replaced_sha256 IS NOT NULL AND length(replaced_sha256)=64 AND replaced_sha256 NOT GLOB '*[^0-9a-f]*')
        OR (outcome<>'file_replaced' AND replaced_sha256 IS NULL))
      AND client_name IS NOT NULL AND length(client_name) BETWEEN 1 AND 128
      AND (client_version IS NULL OR length(client_version) BETWEEN 1 AND 64)
      AND working_directory IS NULL AND executable IS NULL AND run_id IS NULL
      AND ((machine_id IS NOT NULL AND machine_name IS NOT NULL AND ip IS NULL AND country IS NULL)
        OR (machine_id IS NULL AND machine_name IS NULL)))
  ),
  CHECK (
    (outcome IN ('delivered','approval_granted') AND ((approval_id IS NULL AND approval_remember IS NULL AND outcome='delivered') OR (approval_id IS NOT NULL AND approval_remember IS NOT NULL)))
    OR (outcome IN ('approval_requested','approval_denied','approval_withdrawn') AND approval_id IS NOT NULL AND approval_remember IS NULL)
    OR (outcome NOT IN ('delivered','approval_granted','approval_requested','approval_denied','approval_withdrawn') AND approval_id IS NULL AND approval_remember IS NULL)
  )
);
INSERT INTO audit_entries_new(id,at,outcome,path,purpose,machine_id,machine_name,working_directory,executable,run_id,ip,country,bucket,memory_id,file_name,file_size,file_sha256,replaced_sha256,client_name,client_version,agent,agent_session,agent_thread) SELECT id,at,outcome,path,purpose,machine_id,machine_name,working_directory,executable,run_id,ip,country,bucket,memory_id,file_name,file_size,file_sha256,replaced_sha256,client_name,client_version,agent,agent_session,agent_thread FROM audit_entries;
DROP TABLE audit_entries;
ALTER TABLE audit_entries_new RENAME TO audit_entries;
CREATE INDEX audit_entries_chronology ON audit_entries(at DESC, id DESC);
CREATE INDEX audit_entries_secret ON audit_entries(path, at DESC, id DESC);
CREATE INDEX audit_entries_bucket ON audit_entries(bucket, at DESC, id DESC);
CREATE INDEX audit_entries_agent_session ON audit_entries(agent_session, at DESC, id DESC) WHERE agent_session IS NOT NULL;
CREATE TRIGGER audit_entries_assign_bucket AFTER INSERT ON audit_entries WHEN NEW.bucket IS NULL AND NEW.path IS NOT NULL BEGIN
  UPDATE audit_entries SET bucket=substr(NEW.path,1,length(NEW.path)-length(json_extract('["' || replace(NEW.path,'/','","') || '"]','$[#-1]'))-1) WHERE id=NEW.id;
END;
