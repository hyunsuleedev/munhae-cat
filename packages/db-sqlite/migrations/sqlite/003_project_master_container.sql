-- Give every project exactly one immutable master container. Project-wide
-- context is document context on that master and inherits through the tree.

ALTER TABLE document_nodes
  ADD COLUMN is_master INTEGER NOT NULL DEFAULT 0
  CHECK (is_master IN (0, 1));

CREATE TEMP TABLE _master_plan (
  project_id TEXT PRIMARY KEY,
  master_id TEXT NOT NULL UNIQUE,
  insert_master INTEGER NOT NULL CHECK (insert_master IN (0, 1))
) STRICT;

WITH roots AS (
  SELECT
    p.id AS project_id,
    COUNT(d.id) AS root_count,
    SUM(CASE WHEN d.node_role = 'container' THEN 1 ELSE 0 END) AS container_count,
    MAX(CASE WHEN d.node_role = 'container' AND d.title = p.title THEN d.id END) AS titled_container_id,
    MAX(CASE WHEN d.node_role = 'container' THEN d.id END) AS only_container_id
  FROM core_projects p
  LEFT JOIN document_nodes d
    ON d.project_id = p.id
   AND d.parent_node_id IS NULL
   AND d.archived_at IS NULL
  GROUP BY p.id
)
INSERT INTO _master_plan (project_id, master_id, insert_master)
SELECT
  project_id,
  CASE
    WHEN titled_container_id IS NOT NULL THEN titled_container_id
    WHEN root_count = 1 AND container_count = 1 THEN only_container_id
    ELSE lower(
      substr(printf('%012x', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)), 1, 8) || '-' ||
      substr(printf('%012x', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)), 9, 4) || '-7' ||
      substr(hex(randomblob(2)), 2, 3) || '-' ||
      substr(
        '89ab',
        ((instr('0123456789abcdef', lower(substr(hex(randomblob(1)), 1, 1))) - 1) % 4) + 1,
        1
      ) || substr(hex(randomblob(2)), 2, 3) || '-' ||
      hex(randomblob(6))
    )
  END,
  CASE
    WHEN titled_container_id IS NOT NULL THEN 0
    WHEN root_count = 1 AND container_count = 1 THEN 0
    ELSE 1
  END
FROM roots;

INSERT INTO document_nodes (
  id,
  project_id,
  parent_node_id,
  structural_kind,
  title,
  original_title,
  ordinal,
  genre,
  author_person_id,
  language,
  period_text,
  date_text,
  description_md,
  source_reference,
  created_at,
  updated_at,
  archived_at,
  node_role,
  is_master
)
SELECT
  plan.master_id,
  project.id,
  NULL,
  'collection',
  project.title,
  NULL,
  1000000000000,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  project.created_at,
  project.updated_at,
  NULL,
  'container',
  1
FROM _master_plan plan
JOIN core_projects project ON project.id = plan.project_id
WHERE plan.insert_master = 1;

UPDATE document_nodes
SET is_master = 1
WHERE id IN (
  SELECT master_id FROM _master_plan WHERE insert_master = 0
);

CREATE TEMP TABLE _master_root_moves (
  child_id TEXT PRIMARY KEY,
  master_id TEXT NOT NULL,
  final_ordinal INTEGER NOT NULL
) STRICT;

INSERT INTO _master_root_moves (child_id, master_id, final_ordinal)
SELECT
  root.id,
  plan.master_id,
  COALESCE((
    SELECT MAX(existing.ordinal)
    FROM document_nodes existing
    WHERE existing.parent_node_id = plan.master_id
  ), -1) + ROW_NUMBER() OVER (
    PARTITION BY plan.project_id ORDER BY root.ordinal, root.id
  )
FROM _master_plan plan
JOIN document_nodes root
  ON root.project_id = plan.project_id
 AND root.parent_node_id IS NULL
 AND root.id <> plan.master_id;

UPDATE document_nodes
SET
  parent_node_id = (
    SELECT move.master_id FROM _master_root_moves move WHERE move.child_id = document_nodes.id
  ),
  ordinal = (
    SELECT move.final_ordinal FROM _master_root_moves move WHERE move.child_id = document_nodes.id
  )
WHERE id IN (SELECT child_id FROM _master_root_moves);

UPDATE document_nodes
SET ordinal = 0
WHERE is_master = 1;

-- A project-wide context card is the master container's own context. This
-- removes the former duplicate project/document scope concept.
UPDATE context_items
SET
  scope_kind = 'document_node',
  scope_id = (
    SELECT plan.master_id FROM _master_plan plan WHERE plan.project_id = context_items.project_id
  )
WHERE scope_kind IS NULL OR scope_kind = 'project';

DROP TABLE _master_root_moves;
DROP TABLE _master_plan;

CREATE UNIQUE INDEX uq_document_nodes_project_master
  ON document_nodes (project_id)
  WHERE is_master = 1 AND archived_at IS NULL;

CREATE TRIGGER trg_document_nodes_master_shape_insert
BEFORE INSERT ON document_nodes
WHEN NEW.is_master = 1
  AND (NEW.parent_node_id IS NOT NULL OR NEW.node_role <> 'container' OR NEW.archived_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'project master must be an active root container');
END;

CREATE TRIGGER trg_document_nodes_only_master_root_insert
BEFORE INSERT ON document_nodes
WHEN NEW.parent_node_id IS NULL AND NEW.is_master <> 1
BEGIN
  SELECT RAISE(ABORT, 'all document nodes must be inside the project master');
END;

CREATE TRIGGER trg_document_nodes_only_master_root_update
BEFORE UPDATE OF parent_node_id, is_master ON document_nodes
WHEN NEW.parent_node_id IS NULL AND NEW.is_master <> 1
BEGIN
  SELECT RAISE(ABORT, 'all document nodes must be inside the project master');
END;

CREATE TRIGGER trg_document_nodes_master_immutable
BEFORE UPDATE OF parent_node_id, node_role, is_master, archived_at ON document_nodes
WHEN OLD.is_master = 1
  AND (
    NEW.parent_node_id IS NOT NULL OR
    NEW.node_role <> 'container' OR
    NEW.is_master <> 1 OR
    NEW.archived_at IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'project master cannot be moved, archived, or changed from a container');
END;

CREATE TRIGGER trg_document_nodes_master_delete
BEFORE DELETE ON document_nodes
WHEN OLD.is_master = 1
BEGIN
  SELECT RAISE(ABORT, 'project master cannot be deleted');
END;

CREATE TRIGGER trg_context_items_document_scope_insert
BEFORE INSERT ON context_items
WHEN COALESCE(NEW.scope_kind, '') <> 'document_node'
  OR NEW.scope_id IS NULL
  OR NOT EXISTS (
    SELECT 1 FROM document_nodes node
    WHERE node.id = NEW.scope_id AND node.project_id = NEW.project_id AND node.archived_at IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'context items must belong to a document container or source unit');
END;

CREATE TRIGGER trg_context_items_document_scope_update
BEFORE UPDATE OF project_id, scope_kind, scope_id ON context_items
WHEN COALESCE(NEW.scope_kind, '') <> 'document_node'
  OR NEW.scope_id IS NULL
  OR NOT EXISTS (
    SELECT 1 FROM document_nodes node
    WHERE node.id = NEW.scope_id AND node.project_id = NEW.project_id AND node.archived_at IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'context items must belong to a document container or source unit');
END;

UPDATE meta_project_state SET schema_version = 3;
