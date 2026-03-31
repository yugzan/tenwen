-- Run in your Vercel Postgres / Neon SQL console
CREATE TABLE IF NOT EXISTS qa_items (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  tag TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reports (
  id BIGSERIAL PRIMARY KEY,
  item_id TEXT,
  current_question TEXT NOT NULL,
  current_answer TEXT NOT NULL,
  suggested_question TEXT,
  suggested_answer TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  source_ip_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reports_status_created_at ON reports (status, created_at DESC);
