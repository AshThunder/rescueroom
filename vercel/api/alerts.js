// Alerts derived from the same contract events and rules the alert service delivers from.
// Delivery (Telegram, webhook, email) runs in the alert service, not in this public function.
import { alertFor, ALERT_EVENTS } from '../lib/rules.js';
import { eventsFor } from './events.js';
import { APP_URL, DEPLOY, SANDBOX, json } from './_lib.js';

export default async function handler(req, res) {
  const out = [];
  for (const acct of [DEPLOY.vault, SANDBOX.vault].filter(Boolean)) {
    const i = await eventsFor(acct);
    for (const ev of i.events(acct, { limit: 300 }).filter((e) => ALERT_EVENTS.includes(e.event))) {
      const a = alertFor(ev, { app: APP_URL, mainVault: DEPLOY.vault });
      if (a) out.push({ ...a, delivery: { source: 'derived from chain events' } });
    }
  }
  out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const on = (process.env.ALERT_CHANNELS || '').split(',').map((s) => s.trim());
  const channels = { telegram: on.includes('telegram'), webhook: on.includes('webhook'), webhook_signed: on.includes('webhook'), email: on.includes('email'), app_url: APP_URL };
  json(res, 200, { channels, recent: out.slice(0, 50) }, { 'cache-control': 'public, s-maxage=15, stale-while-revalidate=60' });
}
