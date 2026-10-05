-- Term kinds follow the CCTI layers: entities (person, place, period, event, object,
-- work), concepts (concept, allusion) and grammar (grammar, idu). Offices and
-- institutions are concepts; the old catch-all expression becomes grammar, since
-- an 이두 cannot be told apart in stored rows. SQLite cannot alter a CHECK, so both
-- tables are rebuilt with their ids, and every link to them keeps working.
CREATE TABLE terms_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  source_form TEXT NOT NULL CHECK (length(trim(source_form)) > 0 AND length(source_form) <= 300),
  kind TEXT NOT NULL CHECK (kind IN ('person', 'place', 'period', 'event', 'object', 'work', 'concept', 'allusion', 'grammar', 'idu')),
  reading TEXT CHECK (reading IS NULL OR length(reading) <= 300),
  translation TEXT CHECK (translation IS NULL OR length(translation) <= 1000),
  definition TEXT CHECK (definition IS NULL OR length(definition) <= 5000),
  evidence_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_json) AND json_type(evidence_json) = 'array'),
  lock_version INTEGER NOT NULL DEFAULT 1 CHECK (lock_version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO terms_new (id, project_id, source_form, kind, reading, translation, definition, evidence_json, lock_version, created_at, updated_at)
SELECT id, project_id, source_form,
  CASE kind WHEN 'office' THEN 'concept' WHEN 'institution' THEN 'concept' WHEN 'expression' THEN 'grammar' ELSE kind END,
  reading, translation, definition, evidence_json, lock_version, created_at, updated_at
FROM terms;

DROP TABLE terms;
ALTER TABLE terms_new RENAME TO terms;
CREATE INDEX idx_terms_project ON terms (project_id, source_form);

CREATE TABLE term_candidates_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  document_node_id TEXT NOT NULL REFERENCES document_nodes (id),
  punctuation_version_id TEXT NOT NULL REFERENCES punctuation_versions (id),
  run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  model TEXT NOT NULL,
  suggested_term_id TEXT REFERENCES terms (id) ON DELETE SET NULL,
  source_form TEXT NOT NULL CHECK (length(trim(source_form)) > 0 AND length(source_form) <= 300),
  kind TEXT NOT NULL CHECK (kind IN ('person', 'place', 'period', 'event', 'object', 'work', 'concept', 'allusion', 'grammar', 'idu')),
  reading TEXT,
  translation TEXT,
  definition TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_json) AND json_type(evidence_json) = 'array'),
  context_note TEXT,
  selection_reason TEXT,
  uncertainty TEXT,
  positions_json TEXT NOT NULL CHECK (json_valid(positions_json) AND json_type(positions_json) = 'array'),
  dismissed INTEGER NOT NULL DEFAULT 0 CHECK (dismissed IN (0, 1)),
  created_at TEXT NOT NULL
) STRICT;

INSERT INTO term_candidates_new (id, project_id, document_node_id, punctuation_version_id, run_id, agent_id, model, suggested_term_id,
  source_form, kind, reading, translation, definition, evidence_json, context_note, selection_reason, uncertainty, positions_json, dismissed, created_at)
SELECT id, project_id, document_node_id, punctuation_version_id, run_id, agent_id, model, suggested_term_id,
  source_form,
  CASE kind WHEN 'office' THEN 'concept' WHEN 'institution' THEN 'concept' WHEN 'expression' THEN 'grammar' ELSE kind END,
  reading, translation, definition, evidence_json, context_note, selection_reason, uncertainty, positions_json, dismissed, created_at
FROM term_candidates;

DROP TABLE term_candidates;
ALTER TABLE term_candidates_new RENAME TO term_candidates;
CREATE INDEX idx_term_candidates_document ON term_candidates (document_node_id, dismissed);

UPDATE meta_project_state SET schema_version = 16;
