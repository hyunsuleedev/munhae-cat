-- Optional, scoped terminology review; immutable revision snapshots preserve AI drafts.
CREATE TABLE term_entries (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES core_projects(id),
 document_node_id TEXT REFERENCES document_nodes(id),
 parent_term_id TEXT REFERENCES term_entries(id),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 lock_version INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_term_entries_scope ON term_entries(project_id, document_node_id);
CREATE TABLE term_revisions (
 id TEXT PRIMARY KEY,
 term_id TEXT NOT NULL REFERENCES term_entries(id),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 created_at TEXT NOT NULL
) STRICT;

UPDATE meta_project_state SET schema_version = 8;
