-- Translator's footnotes for one exact translation version. Each version owns its rows:
-- a later edit copies them into the new version and finds each quote again, so history
-- keeps exactly what every version carried. A note whose quote no longer occurs keeps
-- its text with a NULL range until someone places it again.
-- Local-only until the online row protocol carries it.
CREATE TABLE translation_notes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  version_id TEXT NOT NULL REFERENCES document_translation_versions (id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('textual', 'allusion', 'identification', 'interpretive')),
  confidence TEXT NOT NULL CHECK (confidence IN ('certain', 'probable', 'unknown')),
  target_quote TEXT NOT NULL CHECK (length(trim(target_quote)) > 0 AND length(target_quote) <= 300),
  codepoint_from INTEGER CHECK (codepoint_from IS NULL OR codepoint_from >= 0),
  codepoint_to INTEGER CHECK (codepoint_to IS NULL OR codepoint_to > codepoint_from),
  source_quote TEXT CHECK (source_quote IS NULL OR (length(trim(source_quote)) > 0 AND length(source_quote) <= 300)),
  body_md TEXT NOT NULL CHECK (length(trim(body_md)) > 0 AND length(body_md) <= 2000),
  alternatives_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(alternatives_json) AND json_type(alternatives_json) = 'array'),
  origin_kind TEXT NOT NULL CHECK (origin_kind IN ('ai', 'human')),
  previous_note_id TEXT REFERENCES translation_notes (id),
  created_at TEXT NOT NULL,
  CHECK ((codepoint_from IS NULL) = (codepoint_to IS NULL))
) STRICT;
CREATE UNIQUE INDEX uq_translation_notes_ordinal ON translation_notes (version_id, ordinal);
CREATE INDEX idx_translation_notes_project ON translation_notes (project_id);
CREATE INDEX idx_translation_notes_previous ON translation_notes (previous_note_id);

CREATE TRIGGER trg_translation_notes_owner_insert
BEFORE INSERT ON translation_notes
WHEN NOT EXISTS (
  SELECT 1 FROM document_translation_versions
  WHERE id = NEW.version_id AND project_id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'translation note must belong to its project version');
END;

UPDATE meta_project_state SET schema_version = 15;
