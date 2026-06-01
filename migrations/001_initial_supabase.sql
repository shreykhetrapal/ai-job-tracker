CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT now()::text
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_stores (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data JSONB NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  count INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback_entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS company_catalog (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  careers_url TEXT NOT NULL UNIQUE,
  notes TEXT NOT NULL DEFAULT '',
  scanner TEXT NOT NULL DEFAULT '',
  source_request_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  test_status TEXT,
  test_summary TEXT,
  last_tested_at TEXT
);

CREATE TABLE IF NOT EXISTS company_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  careers_url TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  test_status TEXT,
  test_summary TEXT,
  admin_notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS email_digest_sends (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_key TEXT NOT NULL,
  digest_id TEXT NOT NULL,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  relevance_score INTEGER,
  sent_at TEXT NOT NULL,
  UNIQUE(user_id, job_key)
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS usage_events_user_type_created_idx ON usage_events(user_id, type, created_at);
CREATE INDEX IF NOT EXISTS feedback_entries_user_created_idx ON feedback_entries(user_id, created_at);
CREATE INDEX IF NOT EXISTS company_requests_user_created_idx ON company_requests(user_id, created_at);
CREATE INDEX IF NOT EXISTS email_digest_sends_user_sent_idx ON email_digest_sends(user_id, sent_at);

INSERT INTO schema_migrations (version)
VALUES ('001_initial_supabase')
ON CONFLICT (version) DO NOTHING;
