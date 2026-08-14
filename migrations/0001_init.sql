-- Writer's full schema. Every statement is idempotent so this migration is
-- safe to apply to a database created before migrations existed.

CREATE TABLE IF NOT EXISTS documents (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'draft', -- draft | processing | archived | deleted
  category    TEXT,
  tags        TEXT, -- JSON array of strings
  summary     TEXT,
  formatted   TEXT, -- agent-formatted Markdown
  agent_trace TEXT, -- JSON: the agent's decision trail (turns, tools)
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  archived_at TEXT,
  deleted_at  TEXT  -- set when moved to the trash; the R2 file is kept
);

CREATE INDEX IF NOT EXISTS idx_documents_status ON documents (status, updated_at);

-- Instance-wide settings, one row. Kept server-side so the editor, the
-- cron janitor and the archiving agent all read the same preferences.
CREATE TABLE IF NOT EXISTS settings (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL DEFAULT '{}'
);
