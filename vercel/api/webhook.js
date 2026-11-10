// Demo receiver for signed alert webhooks: verifies the HMAC-SHA256 signature and timestamp.
// It stores nothing and never acts on the payload.
import { verifyWebhook } from '../lib/webhook-verify.js';
import { json } from './_lib.js';

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  const secret = process.env.ALERT_WEBHOOK_SECRET;
  if (!secret) return json(res, 503, { error: 'receiver not configured' });
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString('utf8');
  if (body.length > 64_000) return json(res, 413, { error: 'too large' });
  if (!verifyWebhook(secret, req.headers, body)) return json(res, 401, { ok: false, error: 'bad or stale signature' });
  let event = null;
  try {
    event = JSON.parse(body).event ?? null;
  } catch {}
  json(res, 200, { ok: true, verified: true, event, delivery: req.headers['x-rescueroom-delivery'] || null });
}
