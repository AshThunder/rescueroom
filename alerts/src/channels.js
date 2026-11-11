// Alert delivery. Each channel turns on when its env vars are set and is skipped otherwise.
//   Telegram: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (TELEGRAM_API_BASE for tests)
//   Webhook:  ALERT_WEBHOOK_URL, ALERT_WEBHOOK_SECRET (HMAC-SHA256 over "<timestamp>.<body>")
//   Email:    SMTP_URL (smtp:// or smtps://user:pass@host:port), ALERT_EMAIL_TO, ALERT_EMAIL_FROM
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const env = (k, e = process.env) => (e[k] || '').trim();

export { signWebhook, verifyWebhook } from './webhook-verify.js';
import { signWebhook } from './webhook-verify.js';

export async function telegram(a, e = process.env, chatOverride) {
  const token = env('TELEGRAM_BOT_TOKEN', e), chat = chatOverride ? String(chatOverride) : env('TELEGRAM_CHAT_ID', e);
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

// Per-vault webhooks (URL set by the vault owner on the factory). Signed with the defender's ed25519 key:
// X-RescueRoom-Signature-Ed25519 = hex(sign("<timestamp>.<body>")), public key at GET /health.
export async function webhookEd25519(a, url, keyPair) {
  const body = JSON.stringify(a);
  const ts = Math.floor(Date.now() / 1000);
  const sig = Buffer.from(keyPair.sign(Buffer.from(`${ts}.${body}`)).signature).toString('hex');
  const headers = { 'content-type': 'application/json', 'user-agent': 'RescueRoom-Alerts/1', 'x-rescueroom-event': a.event, 'x-rescueroom-timestamp': String(ts), 'x-rescueroom-delivery': a.key || crypto.randomUUID(), 'x-rescueroom-signature-ed25519': sig, 'x-rescueroom-key': keyPair.getPublicKey().toString() };
  const r = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000), redirect: 'manual' });
  return r.ok ? `sent ${r.status} (ed25519)` : `failed ${r.status}`;
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

// Channels to skip, e.g. ALERT_MUTE=telegram,email, or a mute file the operator can toggle at runtime:
// ~/.rescueroom/alerts-mute.json  {"channels": ["telegram"], "until": <ms epoch, optional>}
export function mutedChannels(e = process.env) {
  const out = new Set(env('ALERT_MUTE', e).split(',').map((x) => x.trim()).filter(Boolean));
  const file = env('ALERT_MUTE_FILE', e) || path.join(os.homedir(), '.rescueroom', 'alerts-mute.json');
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!m.until || Date.now() < m.until) for (const c of m.channels || []) out.add(c);
  } catch {
    /* no mute file */
  }
  return out;
}

export async function deliver(a, e = process.env) {
  const muted = mutedChannels(e);
  const run = async (fn) => {
    if (muted.has(fn.name)) return 'muted';
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
