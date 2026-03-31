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
    const result = await sql`
      SELECT id, item_id, action, source, source_ref, created_at
      FROM qa_drafts
      ORDER BY created_at DESC
      LIMIT 200
    `;

    return sendJson(res, 200, { drafts: result.rows });
  } catch (error) {
    return sendJson(res, 500, { error: '載入草稿失敗', detail: String(error.message || error) });
  }
};
