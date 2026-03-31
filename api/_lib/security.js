const crypto = require('crypto');

const ipBuckets = new Map();

function hashIp(ip) {
  const value = String(ip || 'unknown');
  return crypto.createHash('sha256').update(value).digest('hex');
}

function extractIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

function checkRateLimit(key, { maxPerMinute = 20 } = {}) {
  const nowMinute = Math.floor(Date.now() / 60000);
  const bucketKey = `${key}:${nowMinute}`;
  const count = (ipBuckets.get(bucketKey) || 0) + 1;
  ipBuckets.set(bucketKey, count);

  // best-effort cleanup
  if (ipBuckets.size > 10000) {
    for (const k of ipBuckets.keys()) {
      if (!k.endsWith(String(nowMinute)) && !k.endsWith(String(nowMinute - 1))) {
        ipBuckets.delete(k);
      }
    }
  }

  return count <= maxPerMinute;
}

async function verifyTurnstile(token, remoteip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    return process.env.NODE_ENV !== 'production';
  }

  if (!token) {
    return false;
  }

  const body = new URLSearchParams();
  body.set('secret', secret);
  body.set('response', token);
  if (remoteip) {
    body.set('remoteip', remoteip);
  }

  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  if (!response.ok) {
    return false;
  }

  const result = await response.json();
  return Boolean(result.success);
}

function ensureAdmin(req) {
  const incoming = req.headers['x-admin-key'];
  const expected = process.env.ADMIN_API_KEY;
  return Boolean(expected && incoming && incoming === expected);
}

module.exports = {
  hashIp,
  extractIp,
  checkRateLimit,
  verifyTurnstile,
  ensureAdmin
};
