-- Contextual readings belong to an exact source version and Unicode range.
-- They do not change source text, translation, or the project-wide glossary.
CREATE TABLE reading_annotations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  document_node_id TEXT NOT NULL REFERENCES document_nodes (id),
  source_version_id TEXT NOT NULL REFERENCES src_text_versions (id),
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64 AND source_content_hash NOT GLOB '*[^0-9a-f]*'),
  codepoint_from INTEGER NOT NULL CHECK (codepoint_from >= 0),
  codepoint_to INTEGER NOT NULL CHECK (codepoint_to > codepoint_from AND codepoint_to <= 20000000 AND codepoint_to - codepoint_from <= 100),
  quote TEXT NOT NULL CHECK (length(quote) = codepoint_to - codepoint_from AND length(trim(quote)) > 0),
  reading TEXT NOT NULL DEFAULT '' CHECK (length(reading) <= 100),
  gloss TEXT NOT NULL DEFAULT '' CHECK (length(gloss) <= 2000),
  reading_order INTEGER CHECK (reading_order IS NULL OR reading_order BETWEEN 1 AND 1000000),
  citation_json TEXT CHECK (citation_json IS NULL OR (
    length(citation_json) <= 40000 AND json_valid(citation_json)
    AND COALESCE(json_type(citation_json) = 'object'
      AND json_type(citation_json, '$.source') = 'text'
      AND json_type(citation_json, '$.sourceLabel') = 'text'
      AND json_type(citation_json, '$.entryId') = 'text'
      AND json_type(citation_json, '$.headword') = 'text'
      AND json_type(citation_json, '$.reading') IN ('text', 'null')
      AND json_type(citation_json, '$.sense') = 'text'
      AND json_type(citation_json, '$.sourceUrl') = 'text'
      AND json_type(citation_json, '$.license') = 'text'
      AND json_type(citation_json, '$.licenseUrl') IN ('text', 'null')
      AND json_type(citation_json, '$.attribution') = 'text', 0)
  )),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  lock_version INTEGER NOT NULL DEFAULT 1 CHECK (lock_version >= 1),
  created_by_actor_id TEXT NOT NULL REFERENCES core_actors (id),
  updated_by_actor_id TEXT NOT NULL REFERENCES core_actors (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  CHECK (length(trim(reading)) > 0 OR length(trim(gloss)) > 0 OR reading_order IS NOT NULL OR citation_json IS NOT NULL)
) STRICT;

CREATE INDEX idx_reading_annotations_document ON reading_annotations (project_id, document_node_id, source_version_id, codepoint_from);
CREATE UNIQUE INDEX uq_reading_annotations_active_range
  ON reading_annotations (project_id, document_node_id, source_version_id, codepoint_from, codepoint_to)
  WHERE archived_at IS NULL;

CREATE TRIGGER trg_reading_annotations_source_insert
BEFORE INSERT ON reading_annotations
WHEN NOT EXISTS (
  SELECT 1 FROM src_text_versions version
  JOIN src_texts source ON source.id = version.source_text_id
  JOIN src_text_heads head ON head.source_text_id = source.id
  JOIN document_nodes node ON node.id = source.document_node_id
  WHERE version.id = NEW.source_version_id AND version.project_id = NEW.project_id
    AND source.project_id = NEW.project_id AND source.tombstoned_at IS NULL
    AND node.id = NEW.document_node_id AND node.project_id = NEW.project_id
    AND node.node_role = 'source_unit' AND node.archived_at IS NULL
    AND head.current_version_id = version.id AND version.state IN ('draft', 'confirmed')
    AND version.content_hash = NEW.source_content_hash
    AND NEW.codepoint_to <= length(version.content_text)
    AND substr(version.content_text, NEW.codepoint_from + 1, NEW.codepoint_to - NEW.codepoint_from) = NEW.quote
)
BEGIN
  SELECT RAISE(ABORT, 'reading annotation must match its current source and exact quote');
END;

CREATE TRIGGER trg_reading_annotations_target_immutable
BEFORE UPDATE OF id, project_id, document_node_id, source_version_id, source_content_hash,
                 codepoint_from, codepoint_to, quote, created_by_actor_id, created_at ON reading_annotations
BEGIN
  SELECT RAISE(ABORT, 'reading annotation target is immutable');
END;

CREATE TRIGGER trg_reading_annotations_current_update
BEFORE UPDATE OF reading, gloss, reading_order, citation_json, content_hash, archived_at ON reading_annotations
WHEN OLD.archived_at IS NOT NULL OR NOT EXISTS (
  SELECT 1 FROM src_text_versions version
  JOIN src_texts source ON source.id = version.source_text_id
  JOIN src_text_heads head ON head.source_text_id = source.id
  JOIN document_nodes node ON node.id = source.document_node_id
  WHERE version.id = OLD.source_version_id AND version.project_id = OLD.project_id
    AND source.project_id = OLD.project_id AND source.tombstoned_at IS NULL
    AND node.id = OLD.document_node_id AND node.project_id = OLD.project_id
    AND node.node_role = 'source_unit' AND node.archived_at IS NULL
    AND head.current_version_id = version.id AND version.state IN ('draft', 'confirmed')
    AND version.content_hash = OLD.source_content_hash
    AND OLD.codepoint_to <= length(version.content_text)
    AND substr(version.content_text, OLD.codepoint_from + 1, OLD.codepoint_to - OLD.codepoint_from) = OLD.quote
)
BEGIN
  SELECT RAISE(ABORT, 'old source reading annotations are read-only');
END;

UPDATE meta_project_state SET schema_version = 6;
