-- Terms are document-first. A term is one sense of one written form; a document
-- uses it only through its own confirmed link on a confirmed punctuation version.
-- The same spelling elsewhere is never applied automatically. Legacy glossary
-- and term-review rows are discarded by product decision.
DROP TABLE term_revisions;
DROP TABLE term_entries;
DROP TABLE glossary_entries;

CREATE TABLE terms (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  source_form TEXT NOT NULL CHECK (length(trim(source_form)) > 0 AND length(source_form) <= 300),
  kind TEXT NOT NULL CHECK (kind IN ('person', 'place', 'office', 'institution', 'work', 'object', 'concept', 'allusion', 'expression')),
  reading TEXT CHECK (reading IS NULL OR length(reading) <= 300),
  translation TEXT CHECK (translation IS NULL OR length(translation) <= 1000),
  definition TEXT CHECK (definition IS NULL OR length(definition) <= 5000),
  evidence_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_json) AND json_type(evidence_json) = 'array'),
  lock_version INTEGER NOT NULL DEFAULT 1 CHECK (lock_version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_terms_project ON terms (project_id, source_form);

-- One confirmed use of a term in one confirmed punctuation version of a document.
CREATE TABLE document_terms (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  document_node_id TEXT NOT NULL REFERENCES document_nodes (id),
  term_id TEXT NOT NULL REFERENCES terms (id),
  punctuation_version_id TEXT NOT NULL REFERENCES punctuation_versions (id),
  context_note TEXT CHECK (context_note IS NULL OR length(context_note) <= 5000),
  selection_reason TEXT CHECK (selection_reason IS NULL OR length(selection_reason) <= 2000),
  uncertainty TEXT CHECK (uncertainty IS NULL OR length(uncertainty) <= 3000),
  origin TEXT NOT NULL CHECK (origin IN ('manual', 'ai')),
  generation_json TEXT CHECK (generation_json IS NULL OR json_valid(generation_json)),
  lock_version INTEGER NOT NULL DEFAULT 1 CHECK (lock_version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (punctuation_version_id, term_id)
) STRICT;

CREATE INDEX idx_document_terms_document ON document_terms (document_node_id, punctuation_version_id);
CREATE INDEX idx_document_terms_term ON document_terms (term_id);

-- Exact positions in the punctuated text. One position belongs to one term.
CREATE TABLE term_occurrences (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  document_term_id TEXT NOT NULL REFERENCES document_terms (id) ON DELETE CASCADE,
  punctuation_version_id TEXT NOT NULL REFERENCES punctuation_versions (id),
  codepoint_from INTEGER NOT NULL CHECK (codepoint_from >= 0),
  codepoint_to INTEGER NOT NULL CHECK (codepoint_to > codepoint_from),
  UNIQUE (punctuation_version_id, codepoint_from, codepoint_to)
) STRICT;

CREATE INDEX idx_term_occurrences_link ON term_occurrences (document_term_id);

CREATE TRIGGER trg_term_occurrences_version
BEFORE INSERT ON term_occurrences
WHEN NOT EXISTS (
  SELECT 1 FROM document_terms
  WHERE id = NEW.document_term_id AND punctuation_version_id = NEW.punctuation_version_id
)
BEGIN
  SELECT RAISE(ABORT, 'term occurrence version mismatch');
END;

-- AI suggestions awaiting a decision. They never reach translation. Dismissed rows
-- stay only so later generations do not repeat the same suggestion.
CREATE TABLE term_candidates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  document_node_id TEXT NOT NULL REFERENCES document_nodes (id),
  punctuation_version_id TEXT NOT NULL REFERENCES punctuation_versions (id),
  run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  model TEXT NOT NULL,
  suggested_term_id TEXT REFERENCES terms (id) ON DELETE SET NULL,
  source_form TEXT NOT NULL CHECK (length(trim(source_form)) > 0 AND length(source_form) <= 300),
  kind TEXT NOT NULL CHECK (kind IN ('person', 'place', 'office', 'institution', 'work', 'object', 'concept', 'allusion', 'expression')),
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

CREATE INDEX idx_term_candidates_document ON term_candidates (document_node_id, dismissed);

UPDATE meta_project_state SET schema_version = 13;
