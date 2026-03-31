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

    const reportResult = await sql`
      SELECT id, item_id, current_question, current_answer, suggested_question, suggested_answer, note, status
      FROM reports
      WHERE id = ${reportId}
      LIMIT 1
    `;

    if (reportResult.rowCount === 0) {
      return sendJson(res, 404, { error: 'Report not found' });
    }

    const report = reportResult.rows[0];

    await sql`
      UPDATE reports
      SET status = 'accepted', updated_at = NOW()
      WHERE id = ${reportId}
    `;

    return sendJson(res, 200, {
      ok: true,
      report: {
        id: report.id,
        itemId: report.item_id,
        currentQuestion: report.current_question,
        currentAnswer: report.current_answer,
        suggestedQuestion: report.suggested_question,
        suggestedAnswer: report.suggested_answer,
        note: report.note,
        status: 'accepted'
      }
    });
  } catch (error) {
    return sendJson(res, 500, { error: '採納失敗', detail: String(error.message || error) });
  }
};
