// Rescue Room hosted defender (Fly.io app rescueroom-defender). One process watches EVERY vault:
//   - watcher: scores held requests on the main demo vault, the sandbox and all factory vaults
//   - relayer: broadcasts MPC-signed Sepolia transactions for vaults that hold Sepolia ETH
//   - alerts: indexes NEP-297 events; main vault -> operator channels, factory vaults -> the owner's
//     linked Telegram chats and webhook, sandbox -> muted
//   - Telegram linking (t.me/<bot>?start=<vault name>)
//   - sandbox defender (scripted guardians for the public attacker sandbox)
//   - demo guardians for one-click demo vaults, expired agent key sweeper
//   - "simulate an attack on my vault" (POST /sim/prepare, POST /sim/start streams Server-Sent Events)
// Keys come from the RR_KEYS secret (never written to disk). GET /health reports state, never secrets.
import http from 'node:http';
import fs from 'node:fs';
import { account, call, view, loadState, loadKeyPair, provider } from '../../scripts/lib/near.js';
import { Indexer, DATA_DIR } from './indexer.js';
import { createRegistry } from './registry.js';
import { startDefender } from './sandbox-defender.js';
import { startDemoDefender } from './demo-defender.js';
import { createSimulator, SimError } from './simulate.js';
import { createDispatcher } from '../../alerts/src/dispatcher.js';
import { chatStore, startTelegramBot } from '../../alerts/src/telegram-bot.js';
import { tick as watcherTick, EVIDENCE_DIR } from '../../watcher/src/watcher.js';
import { detectPatterns, freshFindings } from '../../watcher/src/patterns.js';
import { patternAlert } from '../../alerts/src/rules.js';
import path from 'node:path';
import { relayOnce } from '../../scripts/relayer.mjs';

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const APP = process.env.APP_URL || 'https://rescueroom.vercel.app';
const ORIGINS = new Set((process.env.CORS_ORIGINS || `${APP},http://127.0.0.1:5173,http://localhost:5173`).split(',').map((s) => s.trim()));
const st = loadState();
const MAIN = st.vault;
const SANDBOX = st.sandbox?.vault;
const FACTORY = st.factory;
const GUARDIANS = [st.g1, st.g2, st.g3];
const started = Date.now();
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const ZERO_EVM = '0x0000000000000000000000000000000000000000';

const registry = createRegistry({ view, factory: FACTORY, log });
await registry.refresh();
const indexer = new Indexer([MAIN, SANDBOX, ...registry.ids()].filter(Boolean)).start();
registry.start((added) => added.forEach((v) => indexer.add(v)));

// ---- watcher: one scoring pass at a time per vault
const scoring = new Map();
const watchState = { last_tick: null, scored_passes: 0, last_error: null };
export function scoreVault(v) {
  if (!scoring.has(v)) scoring.set(v, watcherTick(v).finally(() => scoring.delete(v)));
  return scoring.get(v);
}
async function watchLoop() {
  for (;;) {
    try {
      for (const v of [MAIN, ...registry.ids()]) {
        const open = await view(v, 'list_open').catch(() => []);
        if (!open.length) continue;
        const reqs = await Promise.all(open.map((id) => view(v, 'get_request', { id })));
        if (reqs.some((r) => r.status === 'PendingScore' && !r.score)) {
          await scoreVault(v);
          watchState.scored_passes++;
        }
      }
      watchState.last_tick = Date.now();
      watchState.last_error = null;
    } catch (e) {
      watchState.last_error = e.message.slice(0, 200);
    }
    await new Promise((r) => setTimeout(r, Number(process.env.WATCH_INTERVAL_MS || 4000)));
  }
}

// ---- relayer: vaults with a Sepolia safe address (others cannot request ETH)
const ethCache = new Map();
const relayState = { last_tick: null, sent: 0, last_error: null };
async function ethVaults() {
  const out = [MAIN, SANDBOX].filter(Boolean);
  for (const v of registry.ids()) {
    if (!ethCache.has(v)) ethCache.set(v, (await view(v, 'get_config').catch(() => ({ safe_evm: ZERO_EVM }))).safe_evm.toLowerCase() !== ZERO_EVM);
    if (ethCache.get(v)) out.push(v);
  }
  return out;
}
async function relayLoop() {
  for (;;) {
    try {
      for (const v of await ethVaults()) relayState.sent += (await relayOnce(v).catch((e) => (relayState.last_error = `${v}: ${e.message.slice(0, 160)}`, []))).length;
      relayState.last_tick = Date.now();
    } catch (e) {
      relayState.last_error = e.message.slice(0, 200);
    }
    await new Promise((r) => setTimeout(r, 15000));
  }
}

// ---- alerts
const chats = chatStore(DATA_DIR);
const signingKey = (() => {
  try {
    return loadKeyPair('webhook-signing');
  } catch {
    return null;
  }
})();
function safeWebhook(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !/^(localhost|.*\.internal|.*\.local|\[.*\]|\d+\.\d+\.\d+\.\d+)$/i.test(u.hostname);
  } catch {
    return false;
  }
}
const route = async (ev) => {
  if (ev.account === MAIN) return { mode: 'main' };
  if (ev.account === SANDBOX) return process.env.ALERT_SANDBOX === '1' ? { mode: 'main' } : { mode: 'muted', reason: 'muted (public sandbox)' };
  const info = registry.get(ev.account);
  if (!info) return { mode: 'muted', reason: 'unknown vault' };
  return { mode: 'vault', chats: chats.chats(ev.account), webhook: info.alert_webhook && safeWebhook(info.alert_webhook) ? info.alert_webhook : null };
};
const alerts = process.env.ALERTS === '0' ? null : createDispatcher({ indexer, dataDir: DATA_DIR, view, mainVault: MAIN, sandboxVault: SANDBOX, route, signingKey, app: APP });
const tgState = startTelegramBot({
  store: chats,
  app: APP,
  log,
  resolve: async (slug) => (slug === 'demo' ? MAIN : slug === 'sandbox' ? SANDBOX : registry.slug(slug)),
});

// ---- pattern rules: bursts and slow drips of small hot-allowance spends (recommend only, never act)
const PSEEN = path.join(DATA_DIR, 'patterns-seen.json');
const pSeen = new Map(fs.existsSync(PSEEN) ? Object.entries(JSON.parse(fs.readFileSync(PSEEN, 'utf8'))) : []);
const patternState = { last_tick: null, fired: 0, last_error: null };
export async function checkPatterns(v, { force = false } = {}) {
  const [cfg, status, whitelist] = await Promise.all([view(v, 'get_config'), view(v, 'get_status'), view(v, 'get_whitelist').catch(() => [])]);
  const from = Math.max(0, Number(status.next_request_id) - 100);
  const requests = await view(v, 'list_requests', { from_index: from, limit: 100 });
  const found = freshFindings(detectPatterns({ requests, config: cfg, whitelist: whitelist.map(([d]) => d) }));
  const out = [];
  for (const f of found) {
    // one alert per vault + rule + recipient per hour, unless forced (simulation)
    const k = `${v}:${f.rule}:${f.to || ''}`;
    if (!force && Date.now() - (pSeen.get(k) || 0) < 3_600_000) continue;
    pSeen.set(k, Date.now());
    const a = patternAlert(f, { vault: v, app: APP, mainVault: MAIN });
    if (alerts) await alerts.notify(a, v);
    patternState.fired++;
    out.push({ ...f, alert: a });
  }
  if (out.length) fs.writeFileSync(PSEEN, JSON.stringify(Object.fromEntries([...pSeen].filter(([, t]) => Date.now() - t < 86_400_000))));
  return out;
}
async function patternLoop() {
  for (;;) {
    try {
      for (const v of [MAIN, SANDBOX, ...registry.ids()].filter(Boolean)) await checkPatterns(v).catch((e) => (patternState.last_error = `${v}: ${e.message.slice(0, 120)}`));
      patternState.last_tick = Date.now();
    } catch (e) {
      patternState.last_error = e.message.slice(0, 200);
    }
    await new Promise((r) => setTimeout(r, 30000));
  }
}

// ---- defenders
const sandbox = process.env.SANDBOX_DEFENDER === '0' ? null : startDefender({ log: (m) => log(`sandbox: ${m}`) });
const simulator = createSimulator({
  view, call, provider, registry, attacker: st.attacker, demoGuardians: GUARDIANS, scoreVault, checkPatterns: (v) => checkPatterns(v, { force: true }), evidenceDir: EVIDENCE_DIR, app: APP, log,
  transfer: async (from, to, amount) => {
    const r = await account(from).transfer({ receiverId: to, amount });
    return { hash: r.transaction?.hash };
  },
});
const demo = startDemoDefender({ view, call, registry, guardians: GUARDIANS, revoker: st.relayer, busy: (v) => simulator.state().active.includes(v), log });
watchLoop();
relayLoop();
patternLoop();

// ---- HTTP
const clientIp = (req) => String(req.headers['fly-client-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
function cors(req, res) {
  const o = req.headers.origin;
  if (o && ORIGINS.has(o)) {
    res.setHeader('access-control-allow-origin', o);
    res.setHeader('vary', 'origin');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
  }
}
const json = (res, code, body, headers = {}) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};
async function body(req) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > 4096) throw new SimError('body too large', 413);
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new SimError('bad JSON', 400);
  }
}

function health() {
  return {
    ok: true,
    host: 'fly',
    app: process.env.FLY_APP_NAME || 'local',
    region: process.env.FLY_REGION || null,
    uptime_s: Math.round((Date.now() - started) / 1000),
    vaults: { main: MAIN, sandbox: SANDBOX, factory: registry.state(), watched: indexer.accounts.length },
    watcher: { ...watchState, account: st.watcher },
    relayer: { ...relayState, account: st.relayer },
    patterns: patternState,
    indexer: { last_sync: indexer.lastSync, last_error: indexer.lastError },
    alerts: alerts ? { channels: { ...alerts.channels(), per_vault_telegram: !!tgState, linked_chats: chats.count(), linked_vaults: chats.vaults() } } : null,
    telegram_bot: tgState ? { polling: !!tgState.last_poll, last_poll: tgState.last_poll, last_error: tgState.last_error } : null,
    webhook_signing_key: signingKey ? signingKey.getPublicKey().toString() : null,
    sandbox: sandbox?.state ?? null,
    demo_guardians: { accounts: GUARDIANS, ...demo.state },
    simulate: simulator.state(),
  };
}

const server = http.createServer(async (req, res) => {
  cors(req, res);
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    if (req.method === 'GET' && (p === '/health' || p === '/')) return json(res, 200, health());
    if (req.method === 'GET' && p === '/alerts') {
      const v = url.searchParams.get('vault');
      const recent = (alerts?.recent(200) || []).filter((a) => !v || a.vault === v).slice(0, 50).map(({ delivery, ...a }) => ({ ...a, delivery: Object.fromEntries(Object.entries(delivery || {}).map(([k, x]) => [k, String(x).replace(/https?:\/\/\S+/g, '').trim().slice(0, 40)])) }));
      return json(res, 200, { recent });
    }
    if (req.method === 'GET' && p === '/patterns') {
      const v = url.searchParams.get('vault');
      const recent = (alerts?.recent(500) || []).filter((a) => a.kind === 'pattern' && (!v || a.vault === v)).slice(0, 20).map(({ delivery, ...a }) => a);
      return json(res, 200, { recent });
    }
    if (req.method === 'POST' && p === '/sim/prepare') {
      const b = await body(req);
      if (typeof b.vault !== 'string' || b.vault.length > 100) throw new SimError('vault required', 400);
      return json(res, 200, await simulator.prepare({ vault: b.vault, ip: clientIp(req), mode: b.mode === 'batch' ? 'batch' : 'drain' }));
    }
    if (req.method === 'POST' && p === '/sim/start') {
      const b = await body(req);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      let seq = 0;
      const emit = (e) => res.write(`id: ${seq}\nevent: ${e.type}\ndata: ${JSON.stringify({ ...e, seq: seq++ })}\n\n`);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      try {
        await simulator.run(String(b.sim || ''), emit);
      } catch (e) {
        emit({ type: 'error', message: e instanceof SimError ? e.message : `the run stopped: ${String(e.message).slice(0, 160)}` });
      }
      clearInterval(ping);
      emit({ type: 'end' });
      return res.end();
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    if (e instanceof SimError) return json(res, e.code, { error: e.message, retry_after_s: e.retry_after_s || undefined }, e.retry_after_s ? { 'retry-after': String(e.retry_after_s) } : {});
    json(res, 500, { error: 'internal error' });
    log(`http error: ${e.message}`);
  }
});
server.listen(PORT, HOST, () => log(`rescueroom defender on :${PORT}; watching ${indexer.accounts.length} vault(s); data ${DATA_DIR}; evidence ${EVIDENCE_DIR}`));
fs.mkdirSync(DATA_DIR, { recursive: true });
