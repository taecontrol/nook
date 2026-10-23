CREATE TABLE audit_entries_new (
  id TEXT PRIMARY KEY NOT NULL,
  at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('delivered', 'denied', 'created', 'revealed', 'file_attached', 'file_replaced', 'file_downloaded', 'file_detached', 'file_forgotten')),
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
  CHECK (
    (path IS NOT NULL AND purpose IS NOT NULL
      AND memory_id IS NULL AND file_name IS NULL AND file_size IS NULL
      AND file_sha256 IS NULL AND replaced_sha256 IS NULL
      AND client_name IS NULL AND client_version IS NULL
      AND (
        (outcome = 'revealed' AND machine_id IS NULL AND machine_name IS NULL AND working_directory IS NULL AND executable IS NULL AND run_id IS NULL)
        OR (outcome = 'created' AND machine_id IS NOT NULL AND machine_name IS NOT NULL AND working_directory IS NOT NULL AND executable IS NULL AND run_id IS NULL AND ip IS NULL AND country IS NULL)
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
  )
);
INSERT INTO audit_entries_new(id,at,outcome,path,purpose,machine_id,machine_name,working_directory,executable,run_id,ip,country,bucket)
  SELECT id,at,outcome,path,purpose,machine_id,machine_name,working_directory,executable,run_id,ip,country,
    substr(path,1,length(path)-length(json_extract('["' || replace(path,'/','","') || '"]','$[#-1]'))-1)
  FROM audit_entries;
DROP TABLE audit_entries;
ALTER TABLE audit_entries_new RENAME TO audit_entries;
CREATE INDEX audit_entries_chronology ON audit_entries(at DESC, id DESC);
CREATE INDEX audit_entries_secret ON audit_entries(path, at DESC, id DESC);
CREATE INDEX audit_entries_bucket ON audit_entries(bucket, at DESC, id DESC);
CREATE TRIGGER audit_entries_assign_bucket AFTER INSERT ON audit_entries WHEN NEW.bucket IS NULL AND NEW.path IS NOT NULL BEGIN
  UPDATE audit_entries SET bucket=substr(NEW.path,1,length(NEW.path)-length(json_extract('["' || replace(NEW.path,'/','","') || '"]','$[#-1]'))-1) WHERE id=NEW.id;
END;
