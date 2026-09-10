-- Munhae Studio app.sqlite3 (Electron userData). Never store tokens or API keys.
-- credential_reference is an opaque keychain/CLI pointer only.

CREATE TABLE IF NOT EXISTS meta_schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE app_preferences (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE app_recent_projects (
  project_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  package_path TEXT NOT NULL,
  last_opened_at TEXT NOT NULL,
  missing_at TEXT
) STRICT;

CREATE INDEX idx_app_recent_last_opened ON app_recent_projects (last_opened_at);
CREATE UNIQUE INDEX uq_app_recent_package_path ON app_recent_projects (package_path);

CREATE TABLE app_window_state (
  window_key TEXT PRIMARY KEY,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE app_devices (
  id TEXT PRIMARY KEY,
  public_device_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
) STRICT;

CREATE TABLE app_ai_connections (
  id TEXT PRIMARY KEY,
  provider_kind TEXT NOT NULL,
  account_label TEXT,
  credential_reference TEXT,
  status TEXT NOT NULL,
  last_checked_at TEXT
) STRICT;

CREATE TABLE app_runtime_sessions (
  id TEXT PRIMARY KEY,
  provider_kind TEXT NOT NULL,
  project_id TEXT,
  thread_id TEXT,
  provider_session_ref TEXT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE app_pending_diagnostics (
  id TEXT PRIMARY KEY,
  safe_payload_json TEXT NOT NULL CHECK (json_valid(safe_payload_json)),
  consent_state TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
