-- Remove optional edit summaries; version content and authorship remain intact.
ALTER TABLE src_text_versions DROP COLUMN change_summary;
ALTER TABLE punctuation_versions DROP COLUMN change_summary;
UPDATE meta_project_state SET schema_version = 10;
