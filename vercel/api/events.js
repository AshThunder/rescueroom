// NEP-297 events for a Rescue Room vault, read from the FastNEAR transactions API on demand.
// Warm instances keep a cache in /tmp; the CDN caches responses for 15s.
import { Indexer } from '../lib/indexer.js';
import { DEPLOY, SANDBOX, json } from './_lib.js';

const ALLOWED = new Set([DEPLOY.vault, SANDBOX.vault, ...(DEPLOY.legacy_vaults || [])].filter(Boolean));
const FACTORY_SUFFIX = '.factory.rescueroom-j60ox4.testnet';
const allowed = (a) => ALLOWED.has(a) || (a.endsWith(FACTORY_SUFFIX) && /^[a-z0-9-]{2,32}$/.test(a.slice(0, -FACTORY_SUFFIX.length)));
const idx = new Map();

export async function eventsFor(account) {
  let i = idx.get(account);
  if (!i) {
    if (idx.size > 200) idx.delete(idx.keys().next().value);
    idx.set(account, (i = new Indexer([account])));
  }
  if (!i.lastSync || Date.now() - i.lastSync > 10_000) await i.sync();
  return i;
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const account = url.searchParams.get('account') || DEPLOY.vault;
  if (!allowed(account)) return json(res, 400, { error: 'unknown vault' });
  const limit = Math.min(Number(url.searchParams.get('limit') || 200), 1000);
  const i = await eventsFor(account);
  json(res, 200, { account, last_sync: i.lastSync, source: 'FastNEAR tx API (testnet)', events: i.events(account, { limit, event: url.searchParams.get('event') || undefined, requestId: url.searchParams.get('request') ?? undefined }) }, { 'cache-control': 'public, s-maxage=15, stale-while-revalidate=60' });
}
