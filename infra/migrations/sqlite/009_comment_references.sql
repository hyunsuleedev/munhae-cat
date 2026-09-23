CREATE TABLE comment_references (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES core_projects(id),
 comment_id TEXT NOT NULL REFERENCES review_comments(id),
 scope_id TEXT NOT NULL REFERENCES document_nodes(id),
 title TEXT NOT NULL,
 note_md TEXT NOT NULL DEFAULT '',
 condition_md TEXT NOT NULL DEFAULT '',
 inherit_to_children INTEGER NOT NULL DEFAULT 0 CHECK(inherit_to_children IN (0,1)),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 priority INTEGER NOT NULL DEFAULT 0,
 reviewed_comment_lock_version INTEGER NOT NULL,
 needs_review INTEGER NOT NULL DEFAULT 0 CHECK(needs_review IN (0,1)),
 origin_json TEXT NOT NULL CHECK(json_valid(origin_json)),
 legacy_context_item_id TEXT REFERENCES context_items(id),
 lock_version INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 archived_at TEXT
) STRICT;
CREATE INDEX idx_comment_references_comment ON comment_references(project_id,comment_id);
CREATE TRIGGER trg_comment_references_owner_insert BEFORE INSERT ON comment_references
WHEN NOT EXISTS(SELECT 1 FROM review_comments WHERE id=NEW.comment_id AND project_id=NEW.project_id)
 OR NOT EXISTS(SELECT 1 FROM document_nodes WHERE id=NEW.scope_id AND project_id=NEW.project_id AND archived_at IS NULL)
BEGIN SELECT RAISE(ABORT,'comment reference owner mismatch'); END;
CREATE TRIGGER trg_comment_references_owner_update BEFORE UPDATE ON comment_references
WHEN NEW.project_id IS NOT OLD.project_id OR NEW.comment_id IS NOT OLD.comment_id
 OR NOT EXISTS(SELECT 1 FROM document_nodes WHERE id=NEW.scope_id AND project_id=NEW.project_id AND archived_at IS NULL)
BEGIN SELECT RAISE(ABORT,'comment reference owner mismatch'); END;

INSERT INTO comment_references(id,project_id,comment_id,scope_id,title,note_md,condition_md,
 inherit_to_children,enabled,priority,reviewed_comment_lock_version,needs_review,origin_json,
 legacy_context_item_id,lock_version,created_at,updated_at)
SELECT c.id,c.project_id,c.source_comment_id,c.scope_id,c.title,
 CASE WHEN c.content_md=json_extract(a.payload_json,'$.bodyMd') THEN '' ELSE c.content_md END,
 c.condition_md,c.inherit_to_children,c.enabled,c.priority,
 json_extract(a.payload_json,'$.lockVersion'),
 CASE WHEN c.content_md=json_extract(a.payload_json,'$.bodyMd') THEN 0 ELSE 1 END,
 a.payload_json,c.id,c.lock_version,c.created_at,c.updated_at
FROM context_items c JOIN provenance_artifacts a ON a.id=c.origin_artifact_id
JOIN document_nodes n ON n.id=c.scope_id AND n.archived_at IS NULL
WHERE c.source_comment_id IS NOT NULL AND c.archived_at IS NULL;

DROP TRIGGER trg_material_preferences_owner_insert;
DROP TRIGGER trg_material_preferences_owner_update;
DROP INDEX idx_material_preferences_source;
ALTER TABLE material_preferences RENAME TO material_preferences_v8;
CREATE TABLE material_preferences (
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  document_node_id TEXT NOT NULL REFERENCES document_nodes (id),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('context_item', 'document_description', 'comment_reference')),
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
  OR (NEW.source_kind = 'comment_reference' AND NOT EXISTS (SELECT 1 FROM comment_references WHERE id=NEW.source_id AND project_id=NEW.project_id AND archived_at IS NULL))
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


INSERT INTO material_preferences SELECT project_id,document_node_id,
 CASE WHEN source_kind='context_item' AND source_id IN(SELECT id FROM comment_references) THEN 'comment_reference' ELSE source_kind END,
 source_id,referenced,excluded,lock_version,created_by_actor_id,updated_by_actor_id,created_at,updated_at
FROM material_preferences_v8;
DROP TABLE material_preferences_v8;
UPDATE context_items SET archived_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id IN(SELECT legacy_context_item_id FROM comment_references);
UPDATE meta_project_state SET schema_version=9;
