// Alerts: watches the vault and notifies people. Buttons only OPEN signing pages; nothing here signs.
// Channels: Telegram (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID), webhook (ALERT_WEBHOOK_URL),
// email (phase 2; written to the outbox for now), and a local outbox the dashboard can read.
// Usage: node alerts/src/alerts.js [--once]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { view, loadState, fmtNear } from '../../scripts/lib/near.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTBOX = path.resolve(HERE, '../outbox');
const SEEN = path.join(OUTBOX, '.seen.json');
const st = loadState();
const VAULT = process.env.VAULT || st.vault;
const APP = process.env.APP_URL || 'http://127.0.0.1:5173';

export function buildAlert(r) {
  const amount = r.asset === 'Near' ? `${fmtNear(r.amount)} NEAR` : `${Number(BigInt(r.amount)) / 1e18} ETH`;
  const sigs = (r.score?.signals || []).map((s) => s.code.replace(/_/g, ' ')).join(', ');
  const rescued = r.status === 'Rescued';
  return {
    kind: rescued ? 'rescued' : 'held',
    request_id: r.id,
    title: rescued ? `Rescued: ${amount} moved to the safe address` : `Held: ${amount} to ${r.to}`,
    body: rescued ? `Guardians reached quorum on H-${String(r.id).padStart(4, '0')}. The vault is frozen until the DAO unfreezes it.` : `Risk ${r.score.score}/100 (confidence ${r.score.confidence}%). ${sigs}.`,
    // Links only. Each opens a page that shows the exact call before any wallet prompt.
    buttons: rescued
      ? [{ text: 'Open incident', url: `${APP}/app/holds/${r.id}` }]
      : [
          { text: 'Review and vote', url: `${APP}/app/sign/rescue/${r.id}` },
          { text: 'Owner: cancel', url: `${APP}/app/sign/cancel/${r.id}` },
        ],
    evidence_hash: r.score?.evidence_hash,
    at: new Date().toISOString(),
  };
}

async function telegram(a) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return 'skipped (no TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID)';
  // Telegram rejects localhost URLs in buttons; APP_URL must be public for buttons to render.
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: `${a.title}\n${a.body}`, reply_markup: { inline_keyboard: [a.buttons.map((b) => ({ text: b.text, url: b.url }))] } }),
  });
  return r.ok ? 'sent' : `failed ${r.status}`;
}

async function webhook(a) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return 'skipped (no ALERT_WEBHOOK_URL)';
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(a) });
  return r.ok ? `sent ${r.status}` : `failed ${r.status}`;
}

export async function tick() {
  fs.mkdirSync(OUTBOX, { recursive: true });
  const seen = new Set(fs.existsSync(SEEN) ? JSON.parse(fs.readFileSync(SEEN, 'utf8')) : []);
  const reqs = await view(VAULT, 'list_requests', { from_index: 0, limit: 50 });
  for (const r of reqs.reverse()) {
    const key = `${r.id}:${r.status === 'Rescued' ? 'rescued' : 'held'}`;
    const due = (r.status === 'Held' && r.score && r.score.score >= 30) || r.status === 'Rescued';
    if (!due || seen.has(key)) continue;
    const a = buildAlert(r);
    a.delivery = { telegram: await telegram(a).catch((e) => `error ${e.message}`), webhook: await webhook(a).catch((e) => `error ${e.message}`), email: 'queued in outbox (SMTP next phase)' };
    fs.writeFileSync(path.join(OUTBOX, `${r.id}-${a.kind}.json`), JSON.stringify(a, null, 2));
    console.log(`alert ${key}: ${a.title} ->`, a.delivery);
    seen.add(key);
  }
  fs.writeFileSync(SEEN, JSON.stringify([...seen]));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await tick();
  if (!process.argv.includes('--once')) setInterval(() => tick().catch((e) => console.error(e.message)), 5000);
}
