const { sql } = require('@vercel/postgres');

async function ensureTables() {
  await sql`
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
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS qa_drafts (
      id BIGSERIAL PRIMARY KEY,
      item_id TEXT,
      action TEXT NOT NULL,
      before_payload JSONB,
      after_payload JSONB,
      source TEXT,
      source_ref TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

module.exports = {
  sql,
  ensureTables
};
