// Rescue Room watcher: scores held requests, signs the evidence bundle hash and logs it on-chain.
// Usage: node watcher/src/watcher.js [--once]
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { account, view, loadState, loadKeyPair } from '../../scripts/lib/near.js';
import { scoreRequest } from './rules.js';
import { explain } from './explainer.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = path.resolve(HERE, '../evidence');
const st = loadState();
const VAULT = process.env.VAULT || st.vault;
const once = process.argv.includes('--once');

export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

export function scoreMessage(vault, id, score, confidence, hash) {
  return `rescueroom-score:v1:${vault}:${id}:${score}:${confidence}:${hash}`;
}

async function context(vault) {
  const [cfg, status, wl] = await Promise.all([view(vault, 'get_config'), view(vault, 'get_status'), view(vault, 'get_whitelist')]);
  const div = cfg.demo_time_divisor;
  return {
    cfg,
    ctx: {
      whitelist: new Map(wl.map(([d, t]) => [d, Number(t)])),
      availableNear: BigInt(status.near_available),
      allowance: BigInt(cfg.near_allowance.limit),
      windowMs: (cfg.near_allowance.window_secs / div) * 1000,
      nowMs: Date.now(),
      usualHoursUtc: [Number(process.env.USUAL_FROM_UTC ?? 0), Number(process.env.USUAL_TO_UTC ?? 24)],
      freshWhitelistMs: (86400 / div) * 1000,
    },
  };
}

export async function scoreOne(req, history, vault = VAULT) {
  const VAULT = vault;
  const { ctx, cfg } = await context(vault);
  if (req.asset !== 'Near') ctx.allowance = BigInt(cfg.eth_allowance.limit);
  const result = scoreRequest(req, history, ctx);
  const explanation = await explain({ req, result });
  const bundle = {
    v: 1,
    vault: VAULT,
    request: { id: req.id, asset: req.asset, to: req.to, amount: req.amount, requester: req.requester, agent: req.agent, created_ms: req.created_ms },
    model: 'rules-v1',
    score: result.score,
    confidence: result.confidence,
    signals: result.rawSignals,
    explanation,
    scored_at: new Date().toISOString(),
  };
  const hash = crypto.createHash('sha256').update(canonical(bundle)).digest('hex');
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE_DIR, `${VAULT}-${req.id}.json`), JSON.stringify({ hash, bundle }, null, 2));
  const kp = loadKeyPair('watcher-evidence-signing');
  const msg = scoreMessage(VAULT, req.id, result.score, result.confidence, hash);
  const sig = Buffer.from(kp.sign(Buffer.from(msg)).signature).toString('hex');
  await account(st.watcher).callFunction({
    contractId: VAULT,
    methodName: 'submit_score',
    args: { id: req.id, score: result.score, confidence: result.confidence, evidence_hash: hash, signals: result.signals, signature: sig },
    gas: 50n * 10n ** 12n,
  });
  console.log(`scored #${req.id}: ${result.score}/100 (conf ${result.confidence}) ${result.rawSignals.map((s) => s.code).join(', ') || 'no signals'}`);
  return { result, hash, bundle };
}

export async function tick(vault = VAULT) {
  const reqs = await view(vault, 'list_requests', { from_index: 0, limit: 100 });
  const history = [...reqs].reverse();
  for (const r of history) {
    if (r.status === 'PendingScore' && !r.score) {
      try {
        await scoreOne(r, history, vault);
      } catch (e) {
        console.error(`score #${r.id} failed:`, e.message);
      }
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  console.log(`watcher on ${VAULT}`);
  await tick();
  if (!once) setInterval(() => tick().catch((e) => console.error(e.message)), Number(process.env.WATCH_INTERVAL_MS || 4000));
}
