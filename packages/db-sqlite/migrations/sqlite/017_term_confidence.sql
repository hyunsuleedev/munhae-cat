-- A document's term judgment carries how sure it is and its competing readings,
-- the same shape as translation footnotes. A person checks the uses that are not
-- certain or that have alternatives. The free-text selection reason and uncertainty
-- overlapped with each other and with the context note, so they are removed. A
-- written uncertainty becomes 'probable'; its text has no column to move to.
ALTER TABLE document_terms ADD COLUMN confidence TEXT NOT NULL DEFAULT 'certain' CHECK (confidence IN ('certain', 'probable', 'unknown'));
ALTER TABLE document_terms ADD COLUMN alternatives_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(alternatives_json) AND json_type(alternatives_json) = 'array');
UPDATE document_terms SET confidence = 'probable' WHERE uncertainty IS NOT NULL AND trim(uncertainty) <> '';
ALTER TABLE document_terms DROP COLUMN selection_reason;
ALTER TABLE document_terms DROP COLUMN uncertainty;

ALTER TABLE term_candidates ADD COLUMN confidence TEXT NOT NULL DEFAULT 'certain' CHECK (confidence IN ('certain', 'probable', 'unknown'));
ALTER TABLE term_candidates ADD COLUMN alternatives_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(alternatives_json) AND json_type(alternatives_json) = 'array');
UPDATE term_candidates SET confidence = 'probable' WHERE uncertainty IS NOT NULL AND trim(uncertainty) <> '';
ALTER TABLE term_candidates DROP COLUMN selection_reason;
ALTER TABLE term_candidates DROP COLUMN uncertainty;

UPDATE meta_project_state SET schema_version = 17;
