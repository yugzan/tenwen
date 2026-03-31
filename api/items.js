const { sendJson } = require('./_lib/http');
const { sql, ensureTables } = require('./_lib/db');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    await ensureTables();
    const result = await sql`
      SELECT id, question, answer, tag
      FROM qa_items
      ORDER BY question ASC, answer ASC
    `;

    return sendJson(res, 200, { rows: result.rows });
  } catch (error) {
    return sendJson(res, 500, { error: '讀取題庫失敗', detail: String(error.message || error) });
  }
};
