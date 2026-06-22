DROP TABLE IF EXISTS app_state;
DROP TABLE IF EXISTS households;

CREATE TABLE IF NOT EXISTS households (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  invite_code TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
