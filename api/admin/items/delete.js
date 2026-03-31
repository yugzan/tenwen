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
    const id = String(body.id || '').trim();

    if (!id) {
      return sendJson(res, 400, { error: 'id 不可空白' });
    }

    const result = await sql`
      DELETE FROM qa_items
      WHERE id = ${id}
      RETURNING id
    `;

    if (result.rowCount === 0) {
      return sendJson(res, 404, { error: '找不到題目' });
    }

    return sendJson(res, 200, { ok: true });
  } catch (error) {
    return sendJson(res, 500, { error: '刪除題目失敗', detail: String(error.message || error) });
  }
};
