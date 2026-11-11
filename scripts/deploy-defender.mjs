// Deploy the defender to Fly.io (app rescueroom-defender). Uses the box's flyctl login (or FLY_API_TOKEN).
// Writes fly/state.json (public account ids only), stages secrets through stdin (never printed, never on
// disk in the repo) and deploys. Flags: --secrets-only, --no-secrets.
//
// RR_KEYS holds only the keys the hosted defender signs with: watcher, evidence signing, relayer, the demo
// guardians g1-g3 (demo and sandbox defenders), the sandbox owner/safe/agent, the attacker (simulations)
// and the webhook signing key. Never the main owner, factory or vault account keys.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadState, loadKeyPair } from './lib/near.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLY = process.env.FLYCTL || path.join(os.homedir(), '.fly/bin/flyctl');
const APP = 'rescueroom-defender';
const args = new Set(process.argv.slice(2));
const st = loadState();

// 1) public state
const pub = { ...st };
delete pub.funders;
fs.mkdirSync(path.join(ROOT, 'fly'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'fly/state.json'), JSON.stringify(pub, null, 2) + '\n');
for (const v of Object.values(pub).flatMap((x) => (typeof x === 'object' && x ? Object.values(x) : [x]))) {
  if (typeof v === 'string' && /ed25519:|secp256k1:|private/i.test(v) && !/^0x/.test(v) && v.length > 60 && !v.startsWith('secp256k1:')) throw new Error('state looks like it holds a key; refusing');
}
console.log('wrote fly/state.json (account ids only)');

const fly = (a, input) => {
  const r = spawnSync(FLY, a, { cwd: ROOT, input, stdio: [input ? 'pipe' : 'inherit', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`flyctl ${a[0]} ${a[1] || ''} failed (${r.status})`);
};

// 2) secrets
if (!args.has('--no-secrets')) {
  const ids = [st.watcher, 'watcher-evidence-signing', st.relayer, st.g1, st.g2, st.g3, st.sandbox?.owner, st.sandbox?.safe, `agent-key-${st.sandbox?.vault}`, st.attacker, 'webhook-signing'].filter(Boolean);
  const keys = {};
  for (const id of ids) keys[id] = loadKeyPair(id).toString();
  const env = Object.fromEntries(
    fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]),
  );
  const pass = ['NEAR_AI_API_KEY', 'NEAR_AI_MODEL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'ALERT_WEBHOOK_URL', 'ALERT_WEBHOOK_SECRET', 'USUAL_FROM_UTC', 'USUAL_TO_UTC'];
  const lines = [`RR_KEYS=${JSON.stringify(keys)}`, ...pass.filter((k) => env[k]).map((k) => `${k}=${env[k]}`)];
  fly(['secrets', 'import', '--stage', '-a', APP], lines.join('\n') + '\n');
  console.log(`staged ${lines.length} secrets (${ids.length} keys in RR_KEYS); values not shown`);
}
if (args.has('--secrets-only')) process.exit(0);

// 3) deploy
// FLY_IMAGE: deploy a prebuilt image instead of using Fly's remote builder (fallback when the builder is down;
// see docs: image built with crane from node:22-slim plus the same allow-listed files as the Dockerfile).
const img = process.env.FLY_IMAGE ? ['--image', process.env.FLY_IMAGE] : process.env.FLY_DEPOT === '1' ? [] : ['--depot=false'];
fly(['deploy', '-a', APP, ...img, '--ha=false', '--strategy', 'immediate', '--wait-timeout', '300']);
console.log(`deployed: https://${APP}.fly.dev/health`);
