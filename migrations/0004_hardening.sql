-- An hourly budget of sign-in code guesses per address. It outlives any
-- single code, so requesting a fresh code never buys fresh guesses.
-- Reset on a successful sign-in; pruned after a day.
CREATE TABLE IF NOT EXISTS login_guesses (
  email        TEXT PRIMARY KEY,
  window_start TEXT NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0
);

-- Lets the Worker count recent anonymous drafts cheaply (a global cap
-- that keeps an attacker from filling the database).
CREATE INDEX IF NOT EXISTS idx_documents_created ON documents (created_at);
