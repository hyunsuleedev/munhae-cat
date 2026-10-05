-- Uncertainties are removed by product decision; only demo data ever filled them.
-- Children go first so foreign keys stay satisfied; each table's triggers and
-- indexes go with it.
DROP TABLE IF EXISTS uncertainty_anchors;
DROP TABLE IF EXISTS uncertainty_options;
DROP TABLE IF EXISTS uncertainty_versions;
DROP TABLE IF EXISTS uncertainties;

UPDATE meta_project_state SET schema_version = 18;
