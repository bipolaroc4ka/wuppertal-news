-- Wuppertal News Automation: начальная схема D1.
-- Время хранится в UTC: либо 'YYYY-MM-DD HH:MM:SS' (datetime('now')), либо ISO 8601.

CREATE TABLE sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  rss_url TEXT,
  type TEXT NOT NULL CHECK (type IN ('rss','html','api')),
  check_interval_min INTEGER NOT NULL DEFAULT 15,
  is_active INTEGER NOT NULL DEFAULT 1,
  trust_level INTEGER NOT NULL DEFAULT 2,
  etag TEXT,
  last_modified TEXT,
  next_check_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_checked_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sources_due ON sources (is_active, next_check_at);

CREATE TABLE news (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  guid TEXT,
  url TEXT NOT NULL,
  url_canonical TEXT NOT NULL,
  title_orig TEXT NOT NULL,
  body_orig TEXT,
  title_norm TEXT NOT NULL,
  title_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  simhash TEXT,
  published_orig_at TEXT,
  discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  category TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  relevance_score REAL,
  filter_reason TEXT,
  duplicate_of INTEGER REFERENCES news(id),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN
    ('new','filtered','queued','processing','processed','pending',
     'approved','rejected','published','error')),
  title_ru TEXT,
  body_ru TEXT,
  ai_warnings TEXT,
  ai_model TEXT,
  prompt_version TEXT,
  ai_input_hash TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  processed_at TEXT,
  moderation_chat_id TEXT,
  moderation_message_id INTEGER,
  edited_text TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX uq_news_canonical ON news (url_canonical);
CREATE UNIQUE INDEX uq_news_guid ON news (source_id, guid) WHERE guid IS NOT NULL;
CREATE INDEX idx_news_title_hash ON news (title_hash);
CREATE INDEX idx_news_content_hash ON news (content_hash);
CREATE INDEX idx_news_status ON news (status, priority DESC, discovered_at);
CREATE INDEX idx_news_published ON news (published_orig_at);

-- Один и тот же материал у нескольких СМИ
CREATE TABLE news_sources (
  news_id INTEGER NOT NULL REFERENCES news(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  url TEXT NOT NULL,
  title TEXT,
  seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (news_id, url)
);

-- Существенные дополнения к уже известной новости
CREATE TABLE news_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  news_id INTEGER NOT NULL REFERENCES news(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  summary TEXT,
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  applied INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE processed_urls (
  url_canonical TEXT PRIMARY KEY,
  guid TEXT,
  content_hash TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  news_id INTEGER REFERENCES news(id) ON DELETE SET NULL
);

CREATE TABLE processing_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  news_id INTEGER NOT NULL REFERENCES news(id) ON DELETE CASCADE,
  task_type TEXT NOT NULL CHECK (task_type IN ('ai','send_moderation','publish','regenerate')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','running','done','failed','waiting_budget')),
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  run_after TEXT NOT NULL DEFAULT (datetime('now')),
  locked_until TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX uq_queue_active ON processing_queue (news_id, task_type)
  WHERE status IN ('pending','running','waiting_budget');
CREATE INDEX idx_queue_next ON processing_queue (status, run_after, priority DESC);

CREATE TABLE publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  news_id INTEGER NOT NULL UNIQUE REFERENCES news(id),
  channel TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('publishing','published','failed')),
  tg_message_id INTEGER,
  text_published TEXT,
  claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
  published_at TEXT
);

CREATE TABLE admin_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  news_id INTEGER REFERENCES news(id) ON DELETE SET NULL,
  admin_user_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  callback_id TEXT UNIQUE,
  payload TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_admin_actions_news ON admin_actions (news_id);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  news_id INTEGER REFERENCES news(id) ON DELETE SET NULL,
  day TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_ai_usage_day ON ai_usage (day);

CREATE TABLE error_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  message TEXT NOT NULL,
  critical INTEGER NOT NULL DEFAULT 0,
  notified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_error_log_created ON error_log (created_at);
