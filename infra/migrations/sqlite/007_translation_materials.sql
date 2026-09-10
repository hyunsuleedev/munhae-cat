-- Existing cards retain their scope, inheritance and content hashes.
ALTER TABLE context_items ADD COLUMN inherit_to_children INTEGER NOT NULL DEFAULT 1 CHECK (inherit_to_children IN (0, 1));
ALTER TABLE context_items ADD COLUMN condition_md TEXT NOT NULL DEFAULT '';
ALTER TABLE context_items ADD COLUMN source_comment_id TEXT REFERENCES review_comments (id);
ALTER TABLE context_items ADD COLUMN origin_artifact_id TEXT REFERENCES provenance_artifacts (id);
CREATE INDEX idx_context_items_source_comment ON context_items (source_comment_id) WHERE source_comment_id IS NOT NULL;

CREATE TRIGGER trg_context_items_origin_insert
BEFORE INSERT ON context_items
WHEN (NEW.source_comment_id IS NULL) <> (NEW.origin_artifact_id IS NULL)
  OR (NEW.source_comment_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM review_comments comment JOIN provenance_artifacts artifact
      ON artifact.id = NEW.origin_artifact_id AND artifact.project_id = NEW.project_id
    WHERE comment.id = NEW.source_comment_id AND comment.project_id = NEW.project_id
  ))
BEGIN
  SELECT RAISE(ABORT, 'material origin must belong to its project');
END;

CREATE TRIGGER trg_context_items_origin_update
BEFORE UPDATE OF source_comment_id, origin_artifact_id, project_id ON context_items
WHEN (NEW.source_comment_id IS NULL) <> (NEW.origin_artifact_id IS NULL)
  OR (OLD.source_comment_id IS NOT NULL AND (
    NEW.source_comment_id IS NOT OLD.source_comment_id OR NEW.origin_artifact_id IS NOT OLD.origin_artifact_id
  ))
  OR (NEW.source_comment_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM review_comments comment JOIN provenance_artifacts artifact
      ON artifact.id = NEW.origin_artifact_id AND artifact.project_id = NEW.project_id
    WHERE comment.id = NEW.source_comment_id AND comment.project_id = NEW.project_id
  ))
BEGIN
  SELECT RAISE(ABORT, 'material origin is immutable and must belong to its project');
END;

CREATE TABLE material_preferences (
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  document_node_id TEXT NOT NULL REFERENCES document_nodes (id),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('context_item', 'document_description')),
  source_id TEXT NOT NULL,
  referenced INTEGER NOT NULL DEFAULT 0 CHECK (referenced IN (0, 1)),
  excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1)),
  lock_version INTEGER NOT NULL DEFAULT 1 CHECK (lock_version > 0),
  created_by_actor_id TEXT NOT NULL REFERENCES core_actors (id),
  updated_by_actor_id TEXT NOT NULL REFERENCES core_actors (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, document_node_id, source_kind, source_id)
) STRICT;
CREATE INDEX idx_material_preferences_source ON material_preferences (project_id, source_kind, source_id);

CREATE TRIGGER trg_material_preferences_owner_insert
BEFORE INSERT ON material_preferences
WHEN NOT EXISTS (SELECT 1 FROM document_nodes WHERE id = NEW.document_node_id AND project_id = NEW.project_id AND archived_at IS NULL)
  OR (NEW.source_kind = 'context_item' AND NOT EXISTS (
    SELECT 1 FROM context_items WHERE id = NEW.source_id AND project_id = NEW.project_id AND archived_at IS NULL
  ))
  OR (NEW.source_kind = 'document_description' AND NOT EXISTS (
    SELECT 1 FROM document_nodes WHERE id = NEW.source_id AND project_id = NEW.project_id AND archived_at IS NULL
      AND trim(COALESCE(description_md, '')) <> ''
  ))
BEGIN
  SELECT RAISE(ABORT, 'material preference must refer to active nodes and material in its project');
END;

CREATE TRIGGER trg_material_preferences_owner_update
BEFORE UPDATE ON material_preferences
WHEN NEW.project_id IS NOT OLD.project_id OR NEW.document_node_id IS NOT OLD.document_node_id
  OR NEW.source_kind IS NOT OLD.source_kind OR NEW.source_id IS NOT OLD.source_id
BEGIN
  SELECT RAISE(ABORT, 'material preference identity is immutable');
END;

UPDATE meta_project_state SET schema_version = 7;
