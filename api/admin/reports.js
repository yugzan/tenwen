const { sendJson } = require('../_lib/http');
const { sql, ensureTables } = require('../_lib/db');
const { ensureAdmin } = require('../_lib/security');

module.exports = async (req, res) => {
  if (!ensureAdmin(req)) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }

  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    await ensureTables();
    const status = String(req.query?.status || 'pending');
    const allowed = new Set(['pending', 'accepted', 'rejected', 'merged', 'all']);
    if (!allowed.has(status)) {
      return sendJson(res, 400, { error: 'Invalid status' });
    }

    const result = status === 'all'
      ? await sql`
          SELECT id, item_id, current_question, current_answer, suggested_question, suggested_answer, note, status, created_at, updated_at
          FROM reports
          ORDER BY created_at DESC
          LIMIT 500
        `
      : await sql`
          SELECT id, item_id, current_question, current_answer, suggested_question, suggested_answer, note, status, created_at, updated_at
          FROM reports
          WHERE status = ${status}
          ORDER BY created_at DESC
          LIMIT 500
        `;

    return sendJson(res, 200, { reports: result.rows });
  } catch (error) {
    return sendJson(res, 500, { error: '載入回報失敗', detail: String(error.message || error) });
  }
};
