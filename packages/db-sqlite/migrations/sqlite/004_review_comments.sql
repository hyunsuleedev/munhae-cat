CREATE TABLE review_comments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  document_node_id TEXT NOT NULL REFERENCES document_nodes (id),
  translation_version_id TEXT NOT NULL REFERENCES document_translation_versions (id),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('source', 'translation')),
  target_version_id TEXT NOT NULL,
  codepoint_from INTEGER NOT NULL CHECK (codepoint_from >= 0),
  codepoint_to INTEGER NOT NULL CHECK (codepoint_to > codepoint_from),
  quote TEXT NOT NULL CHECK (length(quote) > 0),
  body_md TEXT NOT NULL CHECK (length(trim(body_md)) > 0),
  lock_version INTEGER NOT NULL DEFAULT 1,
  created_by_actor_id TEXT NOT NULL REFERENCES core_actors (id),
  updated_by_actor_id TEXT NOT NULL REFERENCES core_actors (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
) STRICT;

CREATE INDEX idx_review_comments_document ON review_comments (project_id, document_node_id, created_at);
CREATE INDEX idx_review_comments_translation ON review_comments (translation_version_id) WHERE archived_at IS NULL;

CREATE TRIGGER trg_review_comments_owner_insert
BEFORE INSERT ON review_comments
WHEN NOT EXISTS (
  SELECT 1 FROM document_translation_versions version
  JOIN document_translations translation ON translation.id = version.document_translation_id
  JOIN document_nodes node ON node.id = translation.document_node_id
  WHERE version.id = NEW.translation_version_id
    AND version.project_id = NEW.project_id
    AND translation.project_id = NEW.project_id
    AND node.project_id = NEW.project_id
    AND node.id = NEW.document_node_id AND node.archived_at IS NULL
    AND ((NEW.target_kind = 'source' AND NEW.target_version_id = version.source_text_version_id)
      OR (NEW.target_kind = 'translation' AND NEW.target_version_id = version.id))
)
BEGIN
  SELECT RAISE(ABORT, 'review comment must refer to its document translation and source');
END;

CREATE TRIGGER trg_review_comments_target_immutable
BEFORE UPDATE OF project_id, document_node_id, translation_version_id, target_kind, target_version_id,
                 codepoint_from, codepoint_to, quote ON review_comments
BEGIN
  SELECT RAISE(ABORT, 'review comment target is immutable');
END;

UPDATE meta_project_state SET schema_version = 4;
