-- Local-only display link from a reading annotation to the exact part of the linked translation it renders.
-- Kept outside the online row protocol (v10 physical columns stay unchanged); it never edits translation text
-- and is ignored whenever the quote no longer occurs in the current translation.
CREATE TABLE reading_translation_links (
  annotation_id TEXT PRIMARY KEY REFERENCES reading_annotations (id),
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  translation_quote TEXT NOT NULL CHECK (length(translation_quote) <= 500 AND length(trim(translation_quote)) > 0),
  updated_at TEXT NOT NULL
) STRICT;

UPDATE meta_project_state SET schema_version = 11;
