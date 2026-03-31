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

    const hasDraftTable = await sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'qa_drafts'
      ) AS found
    `;

    if (hasDraftTable.rows[0]?.found) {
      const beforePayload = JSON.stringify({
        question: report.current_question,
        answer: report.current_answer,
        tag: null
      });
      const afterPayload = JSON.stringify({
        question: report.suggested_question || report.current_question,
        answer: report.suggested_answer || report.current_answer,
        tag: null
      });

      await sql`
        INSERT INTO qa_drafts (
          item_id,
          action,
          before_payload,
          after_payload,
          source,
          source_ref,
          created_at
        ) VALUES (
          ${report.item_id || null},
          'update',
          ${beforePayload}::jsonb,
          ${afterPayload}::jsonb,
          'report',
          ${String(reportId)},
          NOW()
        )
      `;

      await sql`
        UPDATE reports
        SET status = 'merged', updated_at = NOW()
        WHERE id = ${reportId}
      `;
    }

    return sendJson(res, 200, { ok: true });
  } catch (error) {
    return sendJson(res, 500, { error: '採納失敗', detail: String(error.message || error) });
  }
};
