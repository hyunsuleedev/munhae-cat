-- Context is free text owned by a document node; no content classification is required.
ALTER TABLE context_items DROP COLUMN item_kind;

UPDATE meta_project_state SET schema_version = 3;
