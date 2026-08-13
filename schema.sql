CREATE TABLE IF NOT EXISTS documents (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'draft', -- draft | processing | archived
  category    TEXT,
  tags        TEXT, -- JSON array of strings
  summary     TEXT,
  formatted   TEXT, -- agent-formatted Markdown
  agent_trace TEXT, -- JSON: the agent's decision trail (turns, tools)
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  archived_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_documents_status ON documents (status, updated_at);
