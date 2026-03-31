const { readJsonBody, sendJson } = require('./_lib/http');
const { sql, ensureTables } = require('./_lib/db');
const { extractIp, hashIp, checkRateLimit, verifyTurnstile } = require('./_lib/security');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    await ensureTables();
    const body = await readJsonBody(req);

    const itemId = body.itemId ? String(body.itemId) : null;
    const currentQuestion = String(body.currentQuestion || '').trim();
    const currentAnswer = String(body.currentAnswer || '').trim();
    const suggestedQuestion = String(body.suggestedQuestion || '').trim();
    const suggestedAnswer = String(body.suggestedAnswer || '').trim();
    const note = String(body.note || '').trim();
    const turnstileToken = String(body.turnstileToken || '').trim();

    if (!currentQuestion || !currentAnswer) {
      return sendJson(res, 400, { error: '題目與答案現況不可空白' });
    }

    if (!suggestedQuestion && !suggestedAnswer && !note) {
      return sendJson(res, 400, { error: '建議題目、建議答案、備註至少填一項' });
    }

    const ip = extractIp(req);
    const ipHash = hashIp(ip);

    if (!checkRateLimit(ipHash, { maxPerMinute: 12 })) {
      return sendJson(res, 429, { error: '回報過於頻繁，請稍後再試' });
    }

    const turnstileOk = await verifyTurnstile(turnstileToken, ip);
    if (!turnstileOk) {
      return sendJson(res, 400, { error: 'Turnstile 驗證失敗' });
    }

    const result = await sql`
      INSERT INTO reports (
        item_id,
        current_question,
        current_answer,
        suggested_question,
        suggested_answer,
        note,
        status,
        source_ip_hash
      ) VALUES (
        ${itemId},
        ${currentQuestion},
        ${currentAnswer},
        ${suggestedQuestion || null},
        ${suggestedAnswer || null},
        ${note || null},
        'pending',
        ${ipHash}
      )
      RETURNING id, item_id, status, created_at
    `;

    return sendJson(res, 201, {
      ok: true,
      report: result.rows[0]
    });
  } catch (error) {
    return sendJson(res, 500, { error: '回報失敗', detail: String(error.message || error) });
  }
};
