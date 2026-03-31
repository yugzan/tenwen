const { sendJson, readJsonBody } = require('../../_lib/http');
const { sql, ensureTables } = require('../../_lib/db');
const { ensureAdmin } = require('../../_lib/security');

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
    const rows = Array.isArray(body.rows) ? body.rows : [];

    await sql`BEGIN`;
    try {
      await sql`DELETE FROM qa_items`;

      for (const row of rows) {
        const id = String(row.id || '').trim();
        const question = String(row.question || '').trim();
        const answer = String(row.answer || '').trim();
        const tag = String(row.tag || '').trim();

        if (!id || !question || !answer) {
          continue;
        }

        await sql`
          INSERT INTO qa_items (id, question, answer, tag, created_at, updated_at)
          VALUES (${id}, ${question}, ${answer}, ${tag}, NOW(), NOW())
        `;
      }

      await sql`COMMIT`;
    } catch (error) {
      await sql`ROLLBACK`;
      throw error;
    }

    return sendJson(res, 200, { ok: true, count: rows.length });
  } catch (error) {
    return sendJson(res, 500, { error: '覆蓋題庫失敗', detail: String(error.message || error) });
  }
};
