-- Accounts. Anyone can start writing without one; finishing a piece asks
-- for an email, and every draft written so far is claimed by the account.

-- A document belongs to a user, or (before sign-up) to an anonymous
-- browser identified by an HttpOnly cookie. Documents with neither are
-- from before accounts existed and are visible only in /admin.
ALTER TABLE documents ADD COLUMN user_id TEXT;
ALTER TABLE documents ADD COLUMN anon_id TEXT;
CREATE INDEX IF NOT EXISTS idx_documents_user ON documents (user_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_documents_anon ON documents (anon_id, status);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,              -- stored lowercased
  status        TEXT NOT NULL DEFAULT 'active',    -- active | disabled
  settings      TEXT NOT NULL DEFAULT '{}',        -- JSON: only the keys the user set
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);

-- Session cookies hold a random token; only its SHA-256 lives here.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT,
  user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at);

-- One pending sign-in code per email, single use, short lived.
CREATE TABLE IF NOT EXISTS login_codes (
  email      TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Small key/value store for instance configuration owned by the admin
-- (registration open or closed, analytics salt, login throttling).
CREATE TABLE IF NOT EXISTS site_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Page views and product events for /admin. No raw IP addresses: the
-- visitor column is a hash salted per day, so it counts unique visitors
-- within a day and cannot follow anyone across days.
CREATE TABLE IF NOT EXISTS events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       TEXT NOT NULL,
  day      TEXT NOT NULL,      -- YYYY-MM-DD, UTC
  type     TEXT NOT NULL,      -- pageview | signup | login | finalize | archived | completion | ...
  path     TEXT,
  referrer TEXT,               -- host only
  country  TEXT,
  device   TEXT,               -- desktop | mobile | tablet
  visitor  TEXT,
  user_id  TEXT,
  meta     TEXT                -- small JSON
);
CREATE INDEX IF NOT EXISTS idx_events_day_type ON events (day, type);
CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events (type, ts);
CREATE INDEX IF NOT EXISTS idx_events_user ON events (user_id, ts);
