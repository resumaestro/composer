CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS research (
  id               TEXT PRIMARY KEY,
  company          TEXT NOT NULL,
  r2_key           TEXT NOT NULL,
  fit_score        REAL NOT NULL,
  rejected         INTEGER NOT NULL,
  rejection_reason TEXT,
  researched_at    TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS research_company ON research (company);

CREATE TABLE IF NOT EXISTS resumes (
  id         TEXT PRIMARY KEY,
  company    TEXT NOT NULL,
  r2_key     TEXT NOT NULL,
  model      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO schema_migrations (version) VALUES (1);
