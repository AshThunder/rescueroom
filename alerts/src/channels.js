// Alert delivery. Each channel turns on when its env vars are set and is skipped otherwise.
//   Telegram: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (TELEGRAM_API_BASE for tests)
//   Webhook:  ALERT_WEBHOOK_URL, ALERT_WEBHOOK_SECRET (HMAC-SHA256 over "<timestamp>.<body>")
//   Email:    SMTP_URL (smtp:// or smtps://user:pass@host:port), ALERT_EMAIL_TO, ALERT_EMAIL_FROM
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';

const env = (k, e = process.env) => (e[k] || '').trim();

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

export async function telegram(a, e = process.env) {
  const token = env('TELEGRAM_BOT_TOKEN', e), chat = env('TELEGRAM_CHAT_ID', e);
  if (!token || !chat) return 'skipped (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)';
  const base = env('TELEGRAM_API_BASE', e) || 'https://api.telegram.org';
  // Telegram only renders URL buttons for public https links. Otherwise the links go in the text.
  const httpsLinks = a.buttons.every((b) => b.url.startsWith('https://'));
  const text = [`<b>${esc(a.title)}</b>`, esc(a.body), a.vault ? `Vault: <code>${esc(a.vault)}</code>` : '', httpsLinks ? '' : a.buttons.map((b) => `${esc(b.text)}: ${esc(b.url)}`).join('\n'), a.explorer ? `<a href="${esc(a.explorer)}">Transaction</a>` : '']
    .filter(Boolean)
    .join('\n');
  const body = { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(httpsLinks ? { reply_markup: { inline_keyboard: [a.buttons.map((b) => ({ text: b.text, url: b.url }))] } } : {}) };
  const r = await fetch(`${base}/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  return r.ok ? 'sent' : `failed ${r.status}`;
}

export async function webhook(a, e = process.env) {
  const url = env('ALERT_WEBHOOK_URL', e);
  if (!url) return 'skipped (set ALERT_WEBHOOK_URL)';
  const secret = env('ALERT_WEBHOOK_SECRET', e);
  const body = JSON.stringify(a);
  const ts = Math.floor(Date.now() / 1000);
  const headers = { 'content-type': 'application/json', 'user-agent': 'RescueRoom-Alerts/1', 'x-rescueroom-event': a.event, 'x-rescueroom-timestamp': String(ts), 'x-rescueroom-delivery': a.key || crypto.randomUUID() };
  if (secret) headers['x-rescueroom-signature'] = signWebhook(secret, ts, body);
  const r = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) });
  return r.ok ? `sent ${r.status}${secret ? ' (signed)' : ' (unsigned: set ALERT_WEBHOOK_SECRET)'}` : `failed ${r.status}`;
}

let transport;
export async function email(a, e = process.env) {
  const smtp = env('SMTP_URL', e), to = env('ALERT_EMAIL_TO', e);
  if (!smtp || !to) return 'skipped (set SMTP_URL and ALERT_EMAIL_TO)';
  transport ||= nodemailer.createTransport(smtp, { tls: { rejectUnauthorized: env('SMTP_INSECURE_TLS', e) !== '1' } });
  const from = env('ALERT_EMAIL_FROM', e) || 'Rescue Room <alerts@rescueroom.local>';
  const lines = [a.body, '', ...a.buttons.map((b) => `${b.text}: ${b.url}`), a.explorer ? `Transaction: ${a.explorer}` : ''];
  const html = `<div style="font:14px/1.5 -apple-system,Segoe UI,sans-serif;color:#111"><p style="margin:0 0 12px;font-weight:600">${esc(a.title)}</p><p style="margin:0 0 16px">${esc(a.body)}</p>${a.buttons
    .map((b) => `<a href="${esc(b.url)}" style="display:inline-block;margin:0 8px 8px 0;padding:8px 12px;border:1px solid #111;color:#111;text-decoration:none">${esc(b.text)}</a>`)
    .join('')}${a.explorer ? `<p style="margin:16px 0 0;color:#555">Transaction: <a href="${esc(a.explorer)}">${esc(a.tx_hash || 'explorer')}</a></p>` : ''}<p style="margin:16px 0 0;color:#555;font-size:12px">Links open a page that shows the exact call before any wallet prompt. This email cannot sign anything.</p></div>`;
  const info = await transport.sendMail({ from, to, subject: `[Rescue Room] ${a.title}`, text: lines.join('\n'), html, headers: { 'X-RescueRoom-Event': a.event } });
  return `sent ${info.messageId || ''}`.trim();
}

export function resetEmailTransport() {
  transport = undefined;
}

export async function deliver(a, e = process.env) {
  const run = async (fn) => {
    try {
      return await fn(a, e);
    } catch (err) {
      return `error ${err.message}`;
    }
  };
  const [tg, wh, em] = await Promise.all([run(telegram), run(webhook), run(email)]);
  return { telegram: tg, webhook: wh, email: em };
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
