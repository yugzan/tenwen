const crypto = require('crypto');
const { sendJson, readJsonBody } = require('../../_lib/http');
const { sql, ensureTables } = require('../../_lib/db');
const { ensureAdmin } = require('../../_lib/security');

function buildId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

module.exports = async (req, res) => {
  if (!ensureAdmin(req)) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }

  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    await ensureTables();
    const body = await readJsonBody(req);

    const id = String(body.id || buildId()).trim();
    const question = String(body.question || '').trim();
    const answer = String(body.answer || '').trim();
    const tag = String(body.tag || '').trim();

    if (!question || !answer) {
      return sendJson(res, 400, { error: 'question 與 answer 不可空白' });
    }

    await sql`
      INSERT INTO qa_items (id, question, answer, tag, created_at, updated_at)
      VALUES (${id}, ${question}, ${answer}, ${tag}, NOW(), NOW())
      ON CONFLICT (id) DO UPDATE
      SET question = EXCLUDED.question,
          answer = EXCLUDED.answer,
          tag = EXCLUDED.tag,
          updated_at = NOW()
    `;

    return sendJson(res, 200, { ok: true, row: { id, question, answer, tag } });
  } catch (error) {
    return sendJson(res, 500, { error: '新增題目失敗', detail: String(error.message || error) });
  }
};
