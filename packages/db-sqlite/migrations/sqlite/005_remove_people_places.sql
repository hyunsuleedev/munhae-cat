-- Remove person/place records without copying them into context or artifacts.
-- Keep only directly assigned document author names as document metadata.
ALTER TABLE document_nodes ADD COLUMN author_text TEXT;

UPDATE document_nodes
SET author_text = (
  SELECT person.preferred_name FROM persons person
  WHERE person.id = document_nodes.author_person_id
    AND person.project_id = document_nodes.project_id
)
WHERE author_person_id IS NOT NULL;

DROP INDEX idx_document_nodes_author;
ALTER TABLE document_nodes DROP COLUMN author_person_id;
DROP TABLE persons;
DROP TABLE places;

UPDATE meta_project_state SET schema_version = 5;
