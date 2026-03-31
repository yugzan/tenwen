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

    const itemId = String(body.itemId || '').trim();
    const beforePayload = body.beforePayload ?? null;

    if (!itemId) {
      return sendJson(res, 400, { error: 'itemId 不可空白' });
    }

    if (!beforePayload || typeof beforePayload !== 'object') {
      return sendJson(res, 400, { error: 'beforePayload 不可空白' });
    }

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
        ${itemId},
        'delete',
        ${JSON.stringify(beforePayload)}::jsonb,
        ${null}::jsonb,
        'manual',
        ${null},
        NOW()
      )
    `;

    return sendJson(res, 200, { ok: true });
  } catch (error) {
    return sendJson(res, 500, { error: '建立刪除草稿失敗', detail: String(error.message || error) });
  }
};
