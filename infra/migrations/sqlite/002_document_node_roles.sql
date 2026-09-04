-- Separate hierarchy containers from source-bearing translation units.
-- Legacy nodes that carried both source text and children are normalized by
-- inserting a container wrapper while preserving the source node identity.

ALTER TABLE document_nodes
  ADD COLUMN node_role TEXT NOT NULL DEFAULT 'container'
  CHECK (node_role IN ('container', 'source_unit'));

UPDATE document_nodes
SET node_role = 'source_unit'
WHERE EXISTS (
  SELECT 1
  FROM src_texts s
  WHERE s.document_node_id = document_nodes.id
);

CREATE TEMP TABLE _node_role_hybrids (
  old_id TEXT PRIMARY KEY,
  wrapper_id TEXT NOT NULL UNIQUE,
  old_parent_id TEXT,
  old_ordinal INTEGER NOT NULL
) STRICT;

INSERT INTO _node_role_hybrids (old_id, wrapper_id, old_parent_id, old_ordinal)
SELECT
  d.id,
  lower(hex(randomblob(4))) || '-' ||
  lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6))),
  d.parent_node_id,
  d.ordinal
FROM document_nodes d
WHERE d.node_role = 'source_unit'
  AND EXISTS (
    SELECT 1 FROM document_nodes child WHERE child.parent_node_id = d.id
  );

-- Insert each wrapper at a temporary ordinal. Nested hybrid wrappers point to
-- their parent wrapper immediately, so no source_unit remains a parent after
-- the migration finishes.
WITH wrapper_rows AS (
  SELECT
    h.old_id,
    h.wrapper_id,
    h.old_ordinal,
    d.project_id,
    COALESCE(parent_h.wrapper_id, h.old_parent_id) AS target_parent_id,
    d.structural_kind,
    d.title,
    d.original_title,
    d.genre,
    d.author_person_id,
    d.language,
    d.period_text,
    d.date_text,
    d.description_md,
    d.source_reference,
    d.created_at,
    d.updated_at,
    d.archived_at
  FROM _node_role_hybrids h
  JOIN document_nodes d ON d.id = h.old_id
  LEFT JOIN _node_role_hybrids parent_h ON parent_h.old_id = h.old_parent_id
)
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
  node_role
)
SELECT
  wrapper_id,
  project_id,
  target_parent_id,
  structural_kind,
  title,
  original_title,
  1000000000000 + ROW_NUMBER() OVER (
    PARTITION BY target_parent_id ORDER BY old_ordinal, old_id
  ),
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
  'container'
FROM wrapper_rows;

CREATE TEMP TABLE _node_role_children (
  child_id TEXT PRIMARY KEY,
  new_parent_id TEXT NOT NULL,
  final_ordinal INTEGER NOT NULL
) STRICT;

INSERT INTO _node_role_children (child_id, new_parent_id, final_ordinal)
SELECT child.id, h.wrapper_id, child.ordinal + 1
FROM document_nodes child
JOIN _node_role_hybrids h ON h.old_id = child.parent_node_id
WHERE child.id NOT IN (SELECT old_id FROM _node_role_hybrids)
  AND child.id NOT IN (SELECT wrapper_id FROM _node_role_hybrids);

UPDATE document_nodes
SET
  parent_node_id = (
    SELECT c.new_parent_id FROM _node_role_children c WHERE c.child_id = document_nodes.id
  ),
  ordinal = 2000000000000 + (
    SELECT c.final_ordinal FROM _node_role_children c WHERE c.child_id = document_nodes.id
  )
WHERE id IN (SELECT child_id FROM _node_role_children);

-- The legacy source node keeps its ID and all source/translation/provenance
-- references. It becomes the first source file inside the new wrapper.
UPDATE document_nodes
SET
  parent_node_id = (
    SELECT h.wrapper_id FROM _node_role_hybrids h WHERE h.old_id = document_nodes.id
  ),
  ordinal = 0
WHERE id IN (SELECT old_id FROM _node_role_hybrids);

-- A nested wrapper follows the source file of its parent wrapper; a top-level
-- wrapper replaces the old hybrid at exactly the same hierarchy position.
UPDATE document_nodes
SET ordinal = (
  SELECT h.old_ordinal + CASE WHEN parent_h.old_id IS NULL THEN 0 ELSE 1 END
  FROM _node_role_hybrids h
  LEFT JOIN _node_role_hybrids parent_h ON parent_h.old_id = h.old_parent_id
  WHERE h.wrapper_id = document_nodes.id
)
WHERE id IN (SELECT wrapper_id FROM _node_role_hybrids);

UPDATE document_nodes
SET ordinal = (
  SELECT c.final_ordinal FROM _node_role_children c WHERE c.child_id = document_nodes.id
)
WHERE id IN (SELECT child_id FROM _node_role_children);

-- Context attached to a legacy hybrid described the whole former subtree.
-- Move that scope to the wrapper so the source file and former children keep
-- inheriting the same context.
UPDATE context_items
SET scope_id = (
  SELECT h.wrapper_id FROM _node_role_hybrids h WHERE h.old_id = context_items.scope_id
)
WHERE scope_kind = 'document_node'
  AND scope_id IN (SELECT old_id FROM _node_role_hybrids);

DROP TABLE _node_role_children;
DROP TABLE _node_role_hybrids;

CREATE TRIGGER trg_document_nodes_parent_container_insert
BEFORE INSERT ON document_nodes
WHEN NEW.parent_node_id IS NOT NULL
  AND (SELECT node_role FROM document_nodes WHERE id = NEW.parent_node_id) <> 'container'
BEGIN
  SELECT RAISE(ABORT, 'source_unit nodes cannot contain child nodes');
END;

CREATE TRIGGER trg_document_nodes_parent_container_update
BEFORE UPDATE OF parent_node_id ON document_nodes
WHEN NEW.parent_node_id IS NOT NULL
  AND (SELECT node_role FROM document_nodes WHERE id = NEW.parent_node_id) <> 'container'
BEGIN
  SELECT RAISE(ABORT, 'source_unit nodes cannot contain child nodes');
END;

CREATE TRIGGER trg_document_nodes_role_container
BEFORE UPDATE OF node_role ON document_nodes
WHEN NEW.node_role = 'container'
  AND EXISTS (SELECT 1 FROM src_texts s WHERE s.document_node_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'container nodes cannot contain source text');
END;

CREATE TRIGGER trg_document_nodes_role_source_unit
BEFORE UPDATE OF node_role ON document_nodes
WHEN NEW.node_role = 'source_unit'
  AND EXISTS (SELECT 1 FROM document_nodes child WHERE child.parent_node_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'source_unit nodes cannot contain child nodes');
END;

CREATE TRIGGER trg_src_texts_source_unit_insert
BEFORE INSERT ON src_texts
WHEN (SELECT node_role FROM document_nodes WHERE id = NEW.document_node_id) <> 'source_unit'
BEGIN
  SELECT RAISE(ABORT, 'container nodes cannot contain source text');
END;

CREATE TRIGGER trg_src_texts_source_unit_update
BEFORE UPDATE OF document_node_id ON src_texts
WHEN (SELECT node_role FROM document_nodes WHERE id = NEW.document_node_id) <> 'source_unit'
BEGIN
  SELECT RAISE(ABORT, 'container nodes cannot contain source text');
END;

CREATE TRIGGER trg_src_texts_one_active_insert
BEFORE INSERT ON src_texts
WHEN NEW.tombstoned_at IS NULL
  AND EXISTS (
    SELECT 1 FROM src_texts s
    WHERE s.document_node_id = NEW.document_node_id
      AND s.tombstoned_at IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'source_unit nodes can contain only one active source text');
END;

CREATE TRIGGER trg_src_texts_one_active_update
BEFORE UPDATE OF document_node_id, tombstoned_at ON src_texts
WHEN NEW.tombstoned_at IS NULL
  AND EXISTS (
    SELECT 1 FROM src_texts s
    WHERE s.document_node_id = NEW.document_node_id
      AND s.tombstoned_at IS NULL
      AND s.id <> NEW.id
  )
BEGIN
  SELECT RAISE(ABORT, 'source_unit nodes can contain only one active source text');
END;

CREATE TRIGGER trg_anchor_sets_source_unit_insert
BEFORE INSERT ON translation_anchor_sets
WHEN (SELECT node_role FROM document_nodes WHERE id = NEW.document_node_id) <> 'source_unit'
BEGIN
  SELECT RAISE(ABORT, 'container nodes cannot contain translation anchors');
END;

CREATE TRIGGER trg_document_translations_source_unit_insert
BEFORE INSERT ON document_translations
WHEN (SELECT node_role FROM document_nodes WHERE id = NEW.document_node_id) <> 'source_unit'
BEGIN
  SELECT RAISE(ABORT, 'container nodes cannot contain translations');
END;

UPDATE meta_project_state SET schema_version = 2;
