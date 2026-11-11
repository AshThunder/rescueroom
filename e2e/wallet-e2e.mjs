// Headless wallet test for the signing pages. Drives the real app (local or hosted) through NEAR Wallet
// Selector -> MyNearWallet, with testnet.mynearwallet.com replaced by a scripted test wallet:
//   login  : adds the dApp's function-call key to the test account (as MyNearWallet does) and posts success
//   /sign  : decodes the transaction the app built, checks it against the page's NEAR CLI fallback,
//            signs it with the test account's key from ~/.rescueroom/keys and broadcasts it
// Calls with no deposit are signed in the page with that function-call key; the harness captures the
// broadcast and checks it against the CLI command too. Keys never enter the page.
// Usage: BASE=https://rescueroom.vercel.app node e2e/wallet-e2e.mjs [steps]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeTransaction, decodeSignedTransaction } from 'near-api-js';
import { account, view, loadState, near } from '../scripts/lib/near.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import(process.env.PLAYWRIGHT || '/workspace/rescueroom-mockup/node_modules/playwright/index.mjs');
const BASE = process.env.BASE || 'http://127.0.0.1:5173';
const st = loadState();
const V = st.vault;
const TGAS = 10n ** 12n;
const exe = process.env.CHROME || `${process.env.HOME}/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`;
const results = [];
const addedKeys = [];
let signer = null; // account the test wallet is signed in as
let captured = []; // transactions the page broadcast itself

const log = (...a) => console.log(...a);
const fail = (m) => {
  throw new Error(m);
};

/** Parse the page's NEAR CLI fallback command. */
function parseCli(cmd) {
  const m = cmd.match(/as-transaction (\S+) (\S+) \\\s+json-args '(.*)' \\\s+prepaid-gas '(\d+) Tgas' attached-deposit '([^']+)' \\\s+sign-as (\S+)/s);
  if (!m) fail(`could not parse CLI command: ${cmd.slice(0, 120)}`);
  const dep = m[5] === '0 NEAR' ? 0n : BigInt(m[5].replace(' yoctoNEAR', ''));
  return { receiver: m[1], method: m[2], args: JSON.parse(m[3]), gas: BigInt(m[4]) * TGAS, deposit: dep, signer: m[6] };
}

/** One function-call action -> comparable form. */
function fcOf(tx) {
  if (tx.actions.length !== 1) fail(`expected 1 action, got ${tx.actions.length}`);
  const f = tx.actions[0].functionCall;
  if (!f) fail('action is not a function call');
  return { signer: tx.signerId, receiver: tx.receiverId, method: f.methodName, args: JSON.parse(Buffer.from(f.args).toString('utf8')), gas: BigInt(f.gas), deposit: BigInt(f.deposit) };
}

const canon = (v) => JSON.stringify(v, Object.keys(v).sort());
function compare(label, cli, tx) {
  const diffs = [];
  for (const k of ['receiver', 'method', 'gas', 'deposit', 'signer']) if (String(cli[k]) !== String(tx[k])) diffs.push(`${k}: cli ${cli[k]} vs tx ${tx[k]}`);
  if (canon(cli.args) !== canon(tx.args) || JSON.stringify(cli.args) !== JSON.stringify(tx.args)) diffs.push(`args: cli ${JSON.stringify(cli.args)} vs tx ${JSON.stringify(tx.args)}`);
  if (diffs.length) fail(`${label}: wallet transaction differs from CLI fallback: ${diffs.join('; ')}`);
}

const page_html = (msg) => `<!doctype html><title>test wallet</title><script>window.opener.postMessage(${JSON.stringify(msg)}, '*');</script>`;

async function walletRoute(route) {
  const u = new URL(route.request().url());
  if (u.pathname.startsWith('/login')) {
    const pk = u.searchParams.get('public_key');
    const contract = u.searchParams.get('contract_id');
    await account(signer).addFunctionCallAccessKey({ publicKey: pk, contractId: contract, methodNames: [], allowance: near(0.25) });
    addedKeys.push({ acct: signer, pk });
    log(`  wallet: signed in as ${signer}; added a function-call key for ${contract}`);
    return route.fulfill({ contentType: 'text/html', body: page_html({ status: 'success', account_id: signer, public_key: pk }) });
  }
  if (u.pathname.startsWith('/sign')) {
    const txs = u.searchParams.get('transactions').split(',').map((b) => decodeTransaction(Buffer.from(b, 'base64')));
    pending.wallet = txs.map(fcOf);
    const hashes = [];
    for (const t of txs) {
      const res = await account(signer).signAndSendTransaction({ receiverId: t.receiverId, actions: t.actions });
      hashes.push(res.transaction.hash);
    }
    log(`  wallet: approved ${txs.length} transaction(s) ${hashes.join(',')}`);
    return route.fulfill({ contentType: 'text/html', body: page_html({ status: 'success', transactionHashes: hashes.join(',') }) });
  }
  return route.fulfill({ contentType: 'text/html', body: '<!doctype html>test wallet' });
}
const pending = { wallet: null };

const b = await chromium.launch({ executablePath: exe });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.route('https://testnet.mynearwallet.com/**', walletRoute);
// Capture transactions the page signs itself with its function-call key.
ctx.on('request', (r) => {
  if (r.method() !== 'POST' || !/rpc/.test(r.url())) return;
  try {
    const body = JSON.parse(r.postData() || '{}');
    if (['send_tx', 'broadcast_tx_commit', 'broadcast_tx_async'].includes(body.method)) {
      const raw = Array.isArray(body.params) ? body.params[0] : body.params.signed_tx_base64;
      captured.push(fcOf(decodeSignedTransaction(Buffer.from(raw, 'base64')).transaction));
    }
  } catch {
    /* not a tx */
  }
});
const page = await ctx.newPage();
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(e.message));

async function signIn(acct) {
  signer = acct;
  await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /connect wallet/i }).first().click();
  await page.getByText('MyNearWallet', { exact: false }).first().click();
  await page.waitForFunction((a) => document.body.innerText.includes(a), acct, { timeout: 30000 });
  log(`signed in as ${acct}`);
}

/** Open a signing page, optionally fill fields, sign, and check the transaction against the CLI command. */
async function signPage(label, url, fill = {}) {
  await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle' });
  for (const [id, v] of Object.entries(fill)) {
    const el = page.locator(`#f-${id}`);
    if ((await el.evaluate((n) => n.tagName)) === 'SELECT') await el.selectOption(v);
    else await el.fill(v);
  }
  await page.waitForTimeout(1200); // premium quote, if any
  const cli = parseCli(await page.locator('pre[aria-label="NEAR CLI command"]').textContent());
  captured = [];
  pending.wallet = null;
  await page.getByRole('button', { name: /^Sign with/ }).click();
  const sent = await page.locator('a.banner.g').filter({ hasText: 'Sent' }).first();
  await sent.waitFor({ timeout: 90000 }).catch(async () => {
    const toast = await page.locator('[role="status"], [role="alert"]').allInnerTexts();
    fail(`${label}: no confirmation. Page says: ${toast.join(' | ').slice(0, 300)}`);
  });
  const text = await sent.innerText();
  const tx = pending.wallet?.[0] || captured[0];
  if (!tx) fail(`${label}: no transaction captured`);
  compare(label, cli, tx);
  const hash = (await sent.getAttribute('href')).split('/').pop();
  const ret = text.match(/returned (\S+)/)?.[1];
  const r = { step: label, path: pending.wallet ? 'wallet popup (/sign)' : 'in-page function-call key', signer: tx.signer, method: tx.method, args: tx.args, deposit: tx.deposit.toString(), gas_tgas: Number(tx.gas / TGAS), matches_cli: true, tx: hash, explorer: `https://testnet.nearblocks.io/txns/${hash}`, returned: ret };
  results.push(r);
  log(`  ok ${label}: ${r.path}, matches CLI, tx ${hash}${ret ? `, returned ${ret}` : ''}`);
  return r;
}

const out = { base: BASE, at: new Date().toISOString(), results, notes: [] };
try {
  const dest = process.env.TEST_DEST || 'unknown-payee.testnet';
  await signIn(st.owner);
  const req = await signPage('New withdrawal (owner)', '/app/sign/request/new', { asset: 'Near', to: dest, amount: process.env.TEST_AMOUNT || '1.5', memo: 'wallet e2e: held then cancelled' });
  const id = Number(req.returned);
  out.request_id = id;
  if (process.env.SCORE === '1') {
    const { tick } = await import('../watcher/src/watcher.js');
    fs.rmSync(path.join(process.env.HOME, '.rescueroom/alerts-mute.json'), { force: true }); // allow exactly this alert
    for (let i = 0; i < 20 && !(await view(V, 'get_request', { id })).score; i++) {
      await tick(V);
      await new Promise((r) => setTimeout(r, 2000));
    }
    await new Promise((r) => setTimeout(r, 25000)); // alert service delivers this hold
    fs.writeFileSync(path.join(process.env.HOME, '.rescueroom/alerts-mute.json'), JSON.stringify({ channels: ['telegram'] }), { mode: 0o600 });
    const sc = (await view(V, 'get_request', { id })).score;
    log(`  watcher scored #${id}: ${sc?.score}`);
    // Hosted hold page must show the AI explanation from the evidence_published event, no redeploy.
    let shown = null;
    for (let i = 0; i < 12 && !shown; i++) {
      await page.goto(`${BASE}/app/holds/${id}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(4000);
      const t = await page.locator('body').innerText();
      if (t.includes('published on-chain, hash verified')) shown = t;
      else await page.waitForTimeout(8000);
    }
    if (!shown) fail(`hold #${id}: explanation not shown from chain`);
    const ev = JSON.parse(fs.readFileSync(path.join(ROOT, `watcher/evidence/${V}-${id}.json`), 'utf8'));
    out.explanation = ev.bundle.explanation;
    out.explanation_on_page = shown.includes(ev.bundle.explanation.text);
    await page.screenshot({ path: path.join(ROOT, 'shots/26-hosted-hold-live-explanation.png'), fullPage: true });
    log(`  hold page shows the ${ev.bundle.explanation.provider} explanation: ${out.explanation_on_page}`);
  }
  await signIn('g3.rescueroom-j60ox4.testnet');
  await signPage('Vote rescue (guardian, 1 of 2)', `/app/sign/rescue/${id}`);
  await signIn(st.owner);
  await signPage('Cancel withdrawal (owner)', `/app/sign/cancel/${id}`);
  const cov = await signPage('Buy cover 0.1 NEAR (owner, deposit)', '/app/sign/cover/new', { coverage: '0.1' });
  await page.waitForTimeout(3000);
  const claim = await signPage('File cover claim (owner)', '/app/sign/fileclaim/new', { policy_id: cov.returned, amount: '0.05', request_id: '', reason: 'wallet e2e test claim' });
  out.claim_id = Number(claim.returned);
  await signIn('g3.rescueroom-j60ox4.testnet');
  await signPage('Approve claim (guardian, 1 of 2)', `/app/sign/claim/${out.claim_id}`);
  const r = await view(V, 'get_request', { id });
  out.final_request_status = r.status;
} catch (e) {
  out.error = e.message;
  console.error('FAILED:', e.message);
} finally {
  for (const k of addedKeys) {
    try {
      await account(k.acct).deleteKey(k.pk);
    } catch (e) {
      out.notes.push(`could not delete test key on ${k.acct}: ${e.message}`);
    }
  }
  out.test_keys_removed = addedKeys.length;
  out.page_errors = consoleErrors;
  fs.writeFileSync(path.join(ROOT, 'deploy/wallet-e2e.json'), JSON.stringify(out, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  await b.close();
  log(out.error ? 'wallet e2e FAILED' : 'wallet e2e passed', `(${results.length} signed steps)`);
  process.exit(out.error ? 1 : 0);
}
