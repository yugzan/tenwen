const { sendJson } = require('../../../_lib/http');
const { sql, ensureTables } = require('../../../_lib/db');
const { ensureAdmin } = require('../../../_lib/security');
const crypto = require('crypto');

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
    const currentQuestion = String(report.current_question || '').trim();
    const currentAnswer = String(report.current_answer || '').trim();
    const suggestedQuestion = String(report.suggested_question || '').trim();
    const suggestedAnswer = String(report.suggested_answer || '').trim();

    const nextQuestion = suggestedQuestion || currentQuestion;
    const nextAnswer = suggestedAnswer || currentAnswer;

    let applied = false;
    let action = 'none';
    let row = null;

    if (nextQuestion && nextAnswer) {
      if (report.item_id) {
        const byId = await sql`
          UPDATE qa_items
          SET question = ${nextQuestion},
              answer = ${nextAnswer},
              updated_at = NOW()
          WHERE id = ${report.item_id}
          RETURNING id, question, answer, tag
        `;
        if (byId.rowCount > 0) {
          applied = true;
          action = 'update';
          row = byId.rows[0];
        }
      }

      if (!applied && currentQuestion && currentAnswer) {
        const byMatch = await sql`
          UPDATE qa_items
          SET question = ${nextQuestion},
              answer = ${nextAnswer},
              updated_at = NOW()
          WHERE id IN (
            SELECT id
            FROM qa_items
            WHERE question = ${currentQuestion}
              AND answer = ${currentAnswer}
            ORDER BY created_at ASC
            LIMIT 1
          )
          RETURNING id, question, answer, tag
        `;
        if (byMatch.rowCount > 0) {
          applied = true;
          action = 'update';
          row = byMatch.rows[0];
        }
      }

      if (!applied && suggestedQuestion && suggestedAnswer) {
        const newId = buildId();
        const inserted = await sql`
          INSERT INTO qa_items (id, question, answer, tag, created_at, updated_at)
          VALUES (${newId}, ${nextQuestion}, ${nextAnswer}, '', NOW(), NOW())
          RETURNING id, question, answer, tag
        `;
        if (inserted.rowCount > 0) {
          applied = true;
          action = 'create';
          row = inserted.rows[0];
        }
      }
    }

    await sql`
      UPDATE reports
      SET status = ${applied ? 'merged' : 'accepted'}, updated_at = NOW()
      WHERE id = ${reportId}
    `;

    return sendJson(res, 200, {
      ok: true,
      report: {
        id: report.id,
        itemId: report.item_id,
        currentQuestion: currentQuestion,
        currentAnswer: currentAnswer,
        suggestedQuestion: suggestedQuestion,
        suggestedAnswer: suggestedAnswer,
        note: report.note,
        status: applied ? 'merged' : 'accepted'
      },
      apply: {
        applied,
        action,
        row
      }
    });
  } catch (error) {
    return sendJson(res, 500, { error: '採納失敗', detail: String(error.message || error) });
  }
};
