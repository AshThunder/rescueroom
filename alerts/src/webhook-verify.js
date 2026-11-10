// HMAC-SHA256 webhook signing and verification (no dependencies, usable by any receiver).
import crypto from 'node:crypto';

export function signWebhook(secret, ts, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
}

// For receivers: verify the signature and reject stale timestamps (replay window, default 5 min).
export function verifyWebhook(secret, headers, body, { toleranceSecs = 300, now = Date.now() } = {}) {
  const ts = Number(headers['x-rescueroom-timestamp']);
  const sig = String(headers['x-rescueroom-signature'] || '');
  if (!ts || Math.abs(now / 1000 - ts) > toleranceSecs) return false;
  const want = Buffer.from(signWebhook(secret, ts, body));
  const got = Buffer.from(sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

