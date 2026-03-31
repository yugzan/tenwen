const { sendJson } = require('../../../_lib/http');
const { sql, ensureTables } = require('../../../_lib/db');
const { ensureAdmin } = require('../../../_lib/security');

module.exports = async (req, res) => {
  if (!ensureAdmin(req)) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }

  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    await ensureTables();
    const reportId = Number(req.query?.id);
    if (!Number.isInteger(reportId) || reportId <= 0) {
      return sendJson(res, 400, { error: 'Invalid report id' });
    }

    const result = await sql`
      UPDATE reports
      SET status = 'rejected', updated_at = NOW()
      WHERE id = ${reportId}
      RETURNING id
    `;

    if (result.rowCount === 0) {
      return sendJson(res, 404, { error: 'Report not found' });
    }

    return sendJson(res, 200, { ok: true });
  } catch (error) {
    return sendJson(res, 500, { error: '駁回失敗', detail: String(error.message || error) });
  }
};
