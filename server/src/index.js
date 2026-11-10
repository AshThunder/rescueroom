// Rescue Room local API: event indexer, event-driven alerts and the attacker sandbox.
// Binds to 127.0.0.1 by default. The web app proxies /api here (vite.config.ts).
// Usage: node server/src/index.js   (PORT, HOST, SANDBOX_* and alert env vars in .env.example)
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Account, KeyPairSigner } from 'near-api-js';
import { loadState, view, call, provider, loadKeyPair } from '../../scripts/lib/near.js';
import { Indexer, DATA_DIR } from './indexer.js';
import { createLimiter } from './ratelimit.js';
import { runAttack, Busy } from './sandbox-attack.js';
import { startDefender } from './sandbox-defender.js';
import { createDispatcher } from '../../alerts/src/dispatcher.js';
import { loadChatId, waitForStart } from '../../alerts/src/telegram-link.js';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const st = loadState();
// The defender (watcher + guardian responders + reset) runs here with the privileged keys.
const defender = process.env.SANDBOX_DEFENDER === '0' ? null : startDefender();
const sb = st.sandbox?.vault ? { V: st.sandbox.vault, SAFE: st.sandbox.safe } : null;
const accounts = [st.vault, sb?.V].filter(Boolean);
loadChatId();
const indexer = new Indexer(accounts).start();
if (process.env.ALERTS !== '0' && process.env.TELEGRAM_BOT_TOKEN && !process.env.TELEGRAM_CHAT_ID) waitForStart();
const alerts = process.env.ALERTS === '0' ? null : createDispatcher({ indexer, dataDir: DATA_DIR, view, mainVault: st.vault });
const limiter = createLimiter({
  perClient: Number(process.env.SANDBOX_PER_CLIENT || 2),
  windowMs: Number(process.env.SANDBOX_WINDOW_MIN || 10) * 60_000,
  perDay: Number(process.env.SANDBOX_PER_DAY || 40),
});

// Sandbox runs: one at a time; every run keeps its event list so late subscribers can replay it.
const runs = new Map();
const LAST = path.join(DATA_DIR, 'sandbox-last.json');
let active = null;

function startRun(client) {
  const id = crypto.randomUUID().slice(0, 8);
  const run = { id, client, started: Date.now(), events: [], subs: new Set(), done: false };
  const emit = (e) => {
    const ev = { ...e, seq: run.events.length };
    run.events.push(ev);
    for (const s of run.subs) s(ev);
  };
  runs.set(id, run);
  active = run;
  emit({ type: 'queued', id });
  const keyId = `agent-key-${sb.V}`;
  const kp = loadKeyPair(keyId);
  runAttack({
    emit, call, view, V: sb.V, safe: sb.SAFE, attacker: st.attacker,
    balance: async (id) => (await provider.viewAccount({ accountId: id })).amount,
    agent: new Account(sb.V, provider, new KeyPairSigner(kp)), agentPk: kp.getPublicKey().toString(),
    cooldownS: 0,
  })
    .catch((e) => emit({ type: 'error', message: String(e.message).slice(0, 300) }))
    .finally(() => {
      run.done = true;
      active = null;
      emit({ type: 'end' });
      fs.writeFileSync(LAST, JSON.stringify({ id: run.id, events: run.events }));
      for (const [k, r] of runs) if (Date.now() - r.started > 3_600_000) runs.delete(k);
    });
  return run;
}

const json = (res, code, body, headers = {}) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};
const clientOf = (req) => (process.env.TRUST_PROXY === '1' && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || 'local';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && p === '/api/health') {
      return json(res, 200, { ok: true, accounts, indexer: { last_sync: indexer.lastSync, last_error: indexer.lastError, events: indexer.events(undefined, { limit: 1e6 }).length }, sandbox: sb ? { vault: sb.V, busy: !!active, limits: limiter.stats(), defender: defender?.state ?? null } : null, alerts: alerts?.channels() ?? null });
    }
    if (req.method === 'GET' && p === '/api/events') {
      const limit = Math.min(Number(url.searchParams.get('limit') || 200), 1000);
      const account = url.searchParams.get('account') || st.vault;
      const requestId = url.searchParams.get('request') ?? undefined;
      return json(res, 200, { account, last_sync: indexer.lastSync, source: 'FastNEAR tx API (testnet)', events: indexer.events(account, { limit, event: url.searchParams.get('event') || undefined, requestId }) });
    }
    if (req.method === 'GET' && p === '/api/alerts') {
      return json(res, 200, { channels: alerts?.channels() ?? null, recent: alerts?.recent(50) ?? [] });
    }
    if (req.method === 'POST' && p === '/api/sandbox/run') {
      if (!sb) return json(res, 503, { error: 'sandbox vault not deployed' });
      if (active) return json(res, 409, { error: 'a run is in progress', run: active.id }, { 'retry-after': '30' });
      const client = clientOf(req);
      const lim = limiter.check(client);
      if (!lim.ok) return json(res, 429, { error: lim.reason, retry_after_s: lim.retry_after_s }, { 'retry-after': String(lim.retry_after_s) });
      try {
        const kp = loadKeyPair(`agent-key-${sb.V}`);
        const { admission } = await import('./sandbox-attack.js');
        await admission({ view, V: sb.V, agentPk: kp.getPublicKey().toString(), cooldownS: 0 });
      } catch (e) {
        if (e instanceof Busy) return json(res, 409, { error: e.message, retry_after_s: e.retry_after_s }, { 'retry-after': String(e.retry_after_s) });
        throw e;
      }
      limiter.take(client);
      const run = startRun(client);
      return json(res, 202, { run: run.id, stream: `/api/sandbox/stream/${run.id}` });
    }
    const m = p.match(/^\/api\/sandbox\/stream\/([a-z0-9-]+)$/);
    if (req.method === 'GET' && m) {
      const run = runs.get(m[1]);
      if (!run) return json(res, 404, { error: 'unknown run' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      const send = (ev) => res.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
      const from = Number(req.headers['last-event-id'] ?? -1);
      run.events.filter((e) => e.seq > from).forEach(send);
      if (run.done) return res.end();
      const sub = (ev) => {
        send(ev);
        if (ev.type === 'end') res.end();
      };
      run.subs.add(sub);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => {
        run.subs.delete(sub);
        clearInterval(ping);
      });
      return;
    }
    if (req.method === 'GET' && p === '/api/sandbox/last') {
      const mem = [...runs.values()].filter((r) => r.done).at(-1);
      const last = mem ? { id: mem.id, events: mem.events } : fs.existsSync(LAST) ? JSON.parse(fs.readFileSync(LAST, 'utf8')) : null;
      return json(res, 200, { busy: !!active, active: active?.id ?? null, last, limits: limiter.stats(), vault: sb?.V ?? null });
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => console.log(`rescueroom api on http://${HOST}:${PORT} (indexing ${accounts.join(', ')})`));
