// Assemble the hosted build in .vercel-out/ (gitignored): the static web app, the public API functions,
// and only the shared modules they import. Nothing from ~/.rescueroom or .env is copied.
// Usage: node scripts/vercel-build.mjs   then   cd .vercel-out && vercel deploy --prod
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.vercel-out');
const keep = fs.existsSync(path.join(OUT, '.vercel')) ? fs.readdirSync(path.join(OUT, '.vercel')) : [];
const linkDir = path.join(ROOT, '.vercel-link');
if (keep.length) fs.cpSync(path.join(OUT, '.vercel'), linkDir, { recursive: true });
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'lib'), { recursive: true });

execSync('npm run build', { cwd: path.join(ROOT, 'web'), stdio: 'inherit', env: { ...process.env, VITE_HOSTED: '1' } });
fs.cpSync(path.join(ROOT, 'web/dist'), path.join(OUT, 'public'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'public/evidence'), { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, 'watcher/evidence'))) if (f.endsWith('.json')) fs.copyFileSync(path.join(ROOT, 'watcher/evidence', f), path.join(OUT, 'public/evidence', f));

fs.cpSync(path.join(ROOT, 'vercel/api'), path.join(OUT, 'api'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'vercel/vercel.json'), path.join(OUT, 'vercel.json'));
for (const [src, dst] of [['server/src/indexer.js', 'indexer.js'], ['server/src/sandbox-attack.js', 'sandbox-attack.js'], ['alerts/src/rules.js', 'rules.js'], ['alerts/src/webhook-verify.js', 'webhook-verify.js']]) fs.copyFileSync(path.join(ROOT, src), path.join(OUT, 'lib', dst));

// Public deployment facts only (account ids and addresses), plus the sandbox accounts.
const pub = JSON.parse(fs.readFileSync(path.join(ROOT, 'deploy/testnet.json'), 'utf8'));
const sb = JSON.parse(fs.readFileSync(path.join(ROOT, 'deploy/sandbox.json'), 'utf8'));
pub.sandbox = { vault: sb.vault, safe: sb.safe || sb.safe_near, attacker: pub.attacker };
fs.writeFileSync(path.join(OUT, 'lib/testnet.json'), JSON.stringify(pub, null, 2));

const nearApi = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/near-api-js/package.json'), 'utf8')).version;
fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify({ name: 'rescueroom', private: true, type: 'module', engines: { node: '22.x' }, dependencies: { 'near-api-js': nearApi } }, null, 2));
fs.writeFileSync(path.join(OUT, '.vercelignore'), '.env*\n*.pem\n*.key\n');
if (fs.existsSync(linkDir)) fs.cpSync(linkDir, path.join(OUT, '.vercel'), { recursive: true });
console.log(`built ${OUT}`);
