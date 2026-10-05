-- A term position keeps the sentence it was confirmed in. The sentence is already
-- known when the position is made, so it is stored rather than searched for later
-- among every span of the version. NULL only when no single sentence holds it.
ALTER TABLE term_occurrences ADD COLUMN sentence_span_id TEXT REFERENCES punctuation_structure_spans (id);

UPDATE term_occurrences SET sentence_span_id = (
  SELECT s.id FROM punctuation_structure_spans s
  WHERE s.punctuation_version_id = term_occurrences.punctuation_version_id
    AND s.span_kind IN ('sentence', 'verse_line')
    AND s.codepoint_from <= term_occurrences.codepoint_from AND s.codepoint_to >= term_occurrences.codepoint_to
  ORDER BY s.codepoint_from LIMIT 1
);

CREATE TRIGGER trg_term_occurrences_sentence
BEFORE INSERT ON term_occurrences
WHEN NEW.sentence_span_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM punctuation_structure_spans
  WHERE id = NEW.sentence_span_id AND punctuation_version_id = NEW.punctuation_version_id
    AND span_kind IN ('sentence', 'verse_line')
    AND codepoint_from <= NEW.codepoint_from AND codepoint_to >= NEW.codepoint_to
)
BEGIN
  SELECT RAISE(ABORT, 'term occurrence sentence mismatch');
END;

UPDATE meta_project_state SET schema_version = 14;
