-- Writer 0.14: model usage, richer traffic and product analytics.

-- One row per model call: which feature asked, which model answered, how
-- long it took, how many tokens it used and how many neurons Workers AI
-- says it billed. Dollars are derived from neurons when /admin reads them.
CREATE TABLE IF NOT EXISTS ai_calls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT NOT NULL,
  day           TEXT NOT NULL,              -- YYYY-MM-DD, UTC
  feature       TEXT NOT NULL,              -- completion | agent | embed
  model         TEXT NOT NULL,
  status        TEXT NOT NULL,              -- ok | empty | error
  error         TEXT,
  fallback      INTEGER NOT NULL DEFAULT 0, -- answered after another model failed
  latency_ms    INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0, -- part of input_tokens served from the prompt cache
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0, -- part of output_tokens spent thinking
  neurons       REAL,                       -- what Workers AI reports it billed; NULL when it did not say
  estimated     INTEGER NOT NULL DEFAULT 0, -- tokens counted locally: the response carried no usage
  user_id       TEXT,
  doc_id        TEXT,
  turn          INTEGER,                    -- agent turn
  tool_calls    INTEGER NOT NULL DEFAULT 0,
  finish_reason TEXT,
  log_id        TEXT                        -- AI Gateway log id, when there is one
);
CREATE INDEX IF NOT EXISTS idx_ai_calls_day ON ai_calls (day, model);
CREATE INDEX IF NOT EXISTS idx_ai_calls_feature ON ai_calls (feature, day);
CREATE INDEX IF NOT EXISTS idx_ai_calls_user ON ai_calls (user_id, day);
CREATE INDEX IF NOT EXISTS idx_ai_calls_doc ON ai_calls (doc_id);

-- Page views get a table of their own. Still no IP and no cookie:
-- `visitor` is the daily hash, `session` is derived from it on the server
-- (30 quiet minutes end a session), and `view_id` is a random id the page
-- keeps in memory to report how the view went (engaged time, scroll
-- depth, Web Vitals).
CREATE TABLE IF NOT EXISTS pageviews (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL,
  day          TEXT NOT NULL,
  view_id      TEXT NOT NULL,
  visitor      TEXT NOT NULL,
  session      TEXT NOT NULL,
  entry        INTEGER NOT NULL DEFAULT 0,      -- first view of its session
  path         TEXT NOT NULL,
  referrer     TEXT,                            -- foreign host only
  channel      TEXT NOT NULL DEFAULT 'direct',  -- direct | search | social | ai | email | campaign | referral
  utm_source   TEXT,
  utm_medium   TEXT,
  utm_campaign TEXT,
  country      TEXT,
  device       TEXT,                            -- desktop | mobile | tablet
  browser      TEXT,
  os           TEXT,
  lang         TEXT,                            -- primary language subtag
  viewport     TEXT,                            -- width bucket
  engaged_ms   INTEGER,
  scroll       INTEGER,                         -- deepest scroll, percent
  ttfb         INTEGER,                         -- Web Vitals, milliseconds
  fcp          INTEGER,
  lcp          INTEGER,
  inp          INTEGER,
  cls          INTEGER                          -- layout shift score x 1000
);
CREATE INDEX IF NOT EXISTS idx_pageviews_day ON pageviews (day, path);
CREATE INDEX IF NOT EXISTS idx_pageviews_view ON pageviews (view_id);
CREATE INDEX IF NOT EXISTS idx_pageviews_visitor ON pageviews (visitor, id);
CREATE INDEX IF NOT EXISTS idx_pageviews_session ON pageviews (session);

-- Move the page views recorded so far; each one becomes its own session.
INSERT INTO pageviews (ts, day, view_id, visitor, session, entry, path, referrer, channel, country, device)
SELECT ts, day, 'e' || id, COALESCE(visitor, ''), 'e' || id, 1, COALESCE(path, '/'), referrer,
       CASE
         WHEN referrer IS NULL THEN 'direct'
         WHEN referrer IN ('chatgpt.com', 'chat.openai.com', 'perplexity.ai', 'claude.ai', 'gemini.google.com',
                           'copilot.microsoft.com', 'kimi.com', 'doubao.com', 'deepseek.com') THEN 'ai'
         WHEN referrer LIKE 'google.%' OR referrer IN ('bing.com', 'baidu.com', 'duckduckgo.com', 'sogou.com', 'so.com',
                           'yandex.com', 'yandex.ru', 'search.yahoo.com', 'ecosia.org', 'search.brave.com') THEN 'search'
         WHEN referrer IN ('t.co', 'x.com', 'twitter.com', 'facebook.com', 'linkedin.com', 'reddit.com',
                           'news.ycombinator.com', 'weibo.com', 'zhihu.com', 'xiaohongshu.com', 'v2ex.com',
                           'douban.com', 'bsky.app', 'youtube.com', 'bilibili.com', 'producthunt.com') THEN 'social'
         ELSE 'referral'
       END, country, device
  FROM events
 WHERE type = 'pageview';
DELETE FROM events WHERE type = 'pageview';

-- Product events can point at a document and carry one number.
ALTER TABLE events ADD COLUMN doc_id TEXT;
ALTER TABLE events ADD COLUMN value REAL;
CREATE INDEX IF NOT EXISTS idx_events_doc ON events (doc_id);

-- Who wrote on which day: one row per document per day, bumped by every
-- save. Signed-in writers by account, anonymous ones by the daily visitor
-- hash only, so nobody is followed across days without an account.
CREATE TABLE IF NOT EXISTS writing_days (
  day     TEXT NOT NULL,
  doc_id  TEXT NOT NULL,
  user_id TEXT,
  visitor TEXT,
  saves   INTEGER NOT NULL DEFAULT 0,
  chars   INTEGER NOT NULL DEFAULT 0,  -- length after the day's last save
  PRIMARY KEY (day, doc_id)
);
CREATE INDEX IF NOT EXISTS idx_writing_days_user ON writing_days (user_id, day);
