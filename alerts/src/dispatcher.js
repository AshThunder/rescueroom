// Event-driven alerts: subscribes to the indexer and delivers one alert per qualifying event.
// Every delivery is appended to data/alerts.jsonl (gitignored) for the dashboard.
import fs from 'node:fs';
import path from 'node:path';
import { alertFor, ALERT_EVENTS } from './rules.js';
import { deliver, mutedChannels, telegram, webhookEd25519 } from './channels.js';

// route(ev) (optional, hosted defender): { mode: 'main' | 'muted' | 'vault', chats?: [chatId], webhook?: url }.
// 'main' uses the operator channels from env; 'vault' delivers only to that vault owner's linked chats and webhook.
export function createDispatcher({ indexer, dataDir, view, mainVault, sandboxVault, route, signingKey, app = process.env.APP_URL || 'http://127.0.0.1:5173', backfillMs = Number(process.env.ALERT_BACKFILL_MS || 10 * 60_000) }) {
  const LOG = path.join(dataDir, 'alerts.jsonl');
  const SEEN = path.join(dataDir, 'alerts-seen.json');
  const seen = new Set(fs.existsSync(SEEN) ? JSON.parse(fs.readFileSync(SEEN, 'utf8')) : []);
  const queue = [];
  let busy = false;

  async function handle(ev) {
    if (!ALERT_EVENTS.includes(ev.event) || seen.has(ev.key)) return;
    seen.add(ev.key);
    fs.writeFileSync(SEEN, JSON.stringify([...seen].slice(-5000)));
    if (Date.now() - ev.ts_ms > backfillMs) return; // do not page people about history on first start
    let req;
    if (ev.data?.id !== undefined && ev.event === 'risk_scored') req = await view(ev.account, 'get_request', { id: ev.data.id }).catch(() => undefined);
    const a = alertFor(ev, { app, req, mainVault, sandboxVault });
    if (!a) return;
    if (route) {
      const r = await route(ev);
      if (r.mode === 'muted') a.delivery = { all: r.reason || 'muted' };
      else if (r.mode === 'vault') a.delivery = await deliverToVault(a, r);
      else a.delivery = await deliver(a);
    } else {
      // Public sandbox runs would page people for every visitor: log them, deliver only if ALERT_SANDBOX=1.
      const muted = mainVault && ev.account !== mainVault && process.env.ALERT_SANDBOX !== '1';
      a.delivery = muted ? { all: 'muted (sandbox vault; set ALERT_SANDBOX=1)' } : await deliver(a);
    }
    fs.appendFileSync(LOG, JSON.stringify(a) + '\n');
    console.log(`alert ${a.kind} ${a.title} ->`, a.delivery);
  }

  async function deliverToVault(a, r) {
    const muted = mutedChannels();
    const out = {};
    const chats = muted.has('telegram') ? [] : r.chats || [];
    out.telegram = chats.length ? (await Promise.all(chats.map((c) => telegram(a, process.env, c).catch((e) => `error ${e.message}`)))).join(', ') : muted.has('telegram') ? 'muted' : 'no linked chat';
    out.webhook = r.webhook && signingKey && !muted.has('webhook') ? await webhookEd25519(a, r.webhook, signingKey).catch((e) => `error ${e.message}`) : 'not set';
    return out;
  }

  async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length) await handle(queue.shift()).catch((e) => console.error('alert failed', e.message));
    busy = false;
  }

  indexer.on('event', (ev) => {
    queue.push(ev);
    pump();
  });

  // Off-chain alerts (for example watcher pattern rules), routed like an event from `account`.
  async function notify(a, account) {
    const r = route ? await route({ account, event: 'pattern' }) : { mode: account === mainVault ? 'main' : 'muted', reason: 'muted (sandbox vault; set ALERT_SANDBOX=1)' };
    if (r.mode === 'muted') a.delivery = { all: r.reason || 'muted' };
    else if (r.mode === 'vault') a.delivery = await deliverToVault(a, r);
    else a.delivery = await deliver(a);
    fs.appendFileSync(LOG, JSON.stringify(a) + '\n');
    console.log(`alert ${a.kind} ${a.title} ->`, a.delivery);
    return a;
  }

  return {
    notify,
    recent(limit = 50) {
      if (!fs.existsSync(LOG)) return [];
      return fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).slice(-limit).reverse().map((l) => JSON.parse(l));
    },
    channels() {
      const on = (...k) => k.every((x) => (process.env[x] || '').trim());
      return {
        telegram: on('TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'),
        webhook: on('ALERT_WEBHOOK_URL'),
        webhook_signed: on('ALERT_WEBHOOK_URL', 'ALERT_WEBHOOK_SECRET'),
        email: on('SMTP_URL', 'ALERT_EMAIL_TO'),
        app_url: app,
      };
    },
  };
}
