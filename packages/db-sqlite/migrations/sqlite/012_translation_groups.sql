-- Current local translation entities. Whole-text coordinates are projections only.
CREATE TABLE translation_groups (
  id TEXT PRIMARY KEY,
  document_translation_id TEXT NOT NULL REFERENCES document_translations(id),
  group_key TEXT NOT NULL,
  sentence_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  needs_review INTEGER NOT NULL CHECK(needs_review IN (0,1)),
  reviewed_by TEXT,
  deleted_at TEXT,
  UNIQUE(document_translation_id, group_key)
) STRICT;
CREATE TABLE translation_group_source_links (
  group_id TEXT PRIMARY KEY REFERENCES translation_groups(id),
  source_version_id TEXT NOT NULL REFERENCES src_text_versions(id),
  spans_json TEXT NOT NULL CHECK(json_valid(spans_json))
) STRICT;
CREATE TABLE translation_content_parts (
  id TEXT PRIMARY KEY,
  document_translation_id TEXT NOT NULL REFERENCES document_translations(id),
  group_id TEXT REFERENCES translation_groups(id),
  part_kind TEXT NOT NULL CHECK(part_kind IN ('text','whitespace')),
  order_key TEXT NOT NULL,
  content TEXT NOT NULL CHECK(length(content) > 0),
  revision INTEGER NOT NULL CHECK(revision > 0),
  deleted_at TEXT,
  CHECK(part_kind != 'text' OR group_id IS NOT NULL)
) STRICT;
CREATE INDEX idx_translation_content_parts_document ON translation_content_parts(document_translation_id);
-- Only changed entities get a new immutable revision. Snapshots refer to revisions.
CREATE TABLE translation_content_revisions (
  id TEXT PRIMARY KEY,
  document_translation_id TEXT NOT NULL REFERENCES document_translations(id),
  entity_id TEXT NOT NULL,
  entity_kind TEXT NOT NULL CHECK(entity_kind IN ('group','part')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  value_json TEXT NOT NULL CHECK(json_valid(value_json)),
  UNIQUE(document_translation_id, entity_kind, entity_id, revision)
) STRICT;
CREATE TABLE translation_content_snapshots (
  version_id TEXT PRIMARY KEY REFERENCES document_translation_versions(id),
  group_revisions_json TEXT NOT NULL CHECK(json_valid(group_revisions_json)),
  part_revisions_json TEXT NOT NULL CHECK(json_valid(part_revisions_json))
) STRICT;
UPDATE meta_project_state SET schema_version=12;
