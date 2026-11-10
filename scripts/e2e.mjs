// Live testnet run of the three demo scenarios plus a chain-signature check.
// Usage: node scripts/e2e.mjs [eth|hot|falsealarm|attack|all]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Account, KeyPairSigner } from 'near-api-js';
import { account, call, view, loadState, newKey, loadKeyPair, hasKey, provider, near, fmtNear, TGAS } from './lib/near.js';
import { finalize } from './lib/evm.js';
import { tick as watcherTick } from '../watcher/src/watcher.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const st = loadState();
const V = st.vault;
const log = [];
const step = (name, data = {}) => {
  log.push({ at: new Date().toISOString(), name, ...data });
  console.log(`- ${name}${data.hash ? `  tx ${data.hash}` : ''}${data.note ? `  (${data.note})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const req = (id) => view(V, 'get_request', { id });
const explorer = (h) => `https://testnet.nearblocks.io/txns/${h}`;

async function waitFor(id, pred, label, timeoutMs = 600_000) {
  const t0 = Date.now();
  for (;;) {
    const r = await req(id);
    if (pred(r)) return r;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for #${id} ${label}; status ${r.status}`);
    await sleep(3000);
  }
}

async function request(signer, asset, to, amountYocto, memo) {
  const { hash, value } = await call(signer, V, 'request_withdraw', { asset, to, amount: amountYocto.toString(), memo }, { gas: (asset === 'Near' ? 100n : 300n) * TGAS });
  return { id: value, hash };
}

async function scoreAndShow(id) {
  // RPC views can lag the tx by a block or two; keep ticking the watcher until the score lands.
  for (let i = 0; i < 20; i++) {
    await watcherTick();
    const r = await req(id);
    if (r.score) return r;
    await sleep(2000);
  }
  throw new Error(`#${id} never scored`);
}

async function waitRelease(id) {
  const r = await req(id);
  const ms = Number(r.release_ms) - Date.now();
  if (ms > 0) {
    console.log(`  waiting ${Math.ceil(ms / 1000)}s for hold on #${id}`);
    await sleep(ms + 4000);
  }
}

// ---------------------------------------------------------------- scenarios

async function ethSign() {
  const to = '0x' + '11'.repeat(20);
  const { id, hash } = await request(st.owner, 'SepoliaEth', to, 10n ** 15n, 'chain-signature check (hot)');
  step('ETH request (hot allowance) -> MPC sign', { id, hash });
  const r = await waitFor(id, (x) => x.signature || x.status === 'Failed', 'signature', 180_000);
  if (!r.signature) throw new Error('MPC signing failed');
  const f = finalize(r.evm_tx, r.signature);
  const ok = f.payloadMatches && f.from.toLowerCase() === st.vault_evm.toLowerCase();
  step('MPC signature verified', { id, note: `payload matches ethers: ${f.payloadMatches}; recovered sender ${f.from}; vault address ${st.vault_evm}; ${ok ? 'OK' : 'MISMATCH'}` });
  if (!ok) throw new Error('signature check failed');
  return { id, signedTxHash: f.tx.hash };
}

async function hotSpend() {
  const { id, hash } = await request(st.owner, 'Near', st.relayer, near(0.2), 'payroll top-up (hot)');
  const r = await waitFor(id, (x) => x.status === 'Executed', 'executed', 60_000);
  step('Hot spend executed instantly', { id, hash, note: `status ${r.status}` });
}

async function falseAlarm() {
  // A vendor the vault has never paid: flagged. Owner cancels, whitelists, resends.
  // Each run uses a brand-new vendor account so the story starts clean.
  const prefix = `vendor-${Date.now().toString(36)}`;
  const vendor = `${prefix}.${st.main}`;
  await account(st.main).createSubAccount({ accountOrPrefix: prefix, publicKey: (await account(st.main).getSigner().getPublicKey()).toString(), nearToTransfer: near(0.05) });
  step('New vendor account (never paid before)', { note: vendor });
  const amt = near(1.2);
  const a = await request(st.owner, 'Near', vendor, amt, 'Vendor invoice #88 (1,200 NEAR scaled to 1.2)');
  step('Vendor payment requested (beyond allowance)', { id: a.id, hash: a.hash });
  const s = await scoreAndShow(a.id);
  step('Watcher flagged it', { id: a.id, note: `score ${s.score.score}, hold until ${new Date(Number(s.release_ms)).toISOString()}` });
  const c = await call(st.owner, V, 'cancel', { id: a.id });
  step('Owner cancelled own flagged request', { id: a.id, hash: c.hash });
  const w = await call(st.owner, V, 'whitelist_add', { destination: vendor, label: 'Acme Vendor' });
  step('Owner whitelisted vendor', { hash: w.hash });
  const b = await request(st.owner, 'Near', vendor, amt, 'Vendor invoice #88 (resend)');
  step('Resent payment', { id: b.id, hash: b.hash });
  const s2 = await scoreAndShow(b.id);
  step('Watcher rescored', { id: b.id, note: `score ${s2.score.score}, signals ${s2.score.signals.map((x) => x.code).join(',')}` });
  await waitRelease(b.id);
  const e = await call('relayer.' + st.main, V, 'execute', { id: b.id }, { gas: 100n * TGAS });
  const done = await waitFor(b.id, (x) => x.status === 'Executed' || x.status === 'Failed', 'executed', 60_000);
  step('Vendor paid after hold', { id: b.id, hash: e.hash, note: done.status });
}

async function agentAccount() {
  const keyId = `agent-key-${V}`;
  let pk;
  if (!hasKey(keyId)) {
    pk = newKey(keyId);
    const r = await call(st.owner, V, 'add_agent_key', { public_key: pk, label: 'ops-agent' }, { deposit: 1n, gas: 100n * TGAS });
    step('Owner gave the AI agent a request-only key', { hash: r.hash });
  }
  return new Account(V, provider, new KeyPairSigner(loadKeyPair(keyId)));
}

async function daoUnfreeze() {
  // Unfreeze through a Sputnik DAO FunctionCall proposal.
  const policy = await view(st.dao, 'get_policy');
  const bond = BigInt(policy.proposal_bond);
  const kind = { FunctionCall: { receiver_id: V, actions: [{ method_name: 'dao_unfreeze', args: Buffer.from('{}').toString('base64'), deposit: '0', gas: (30n * TGAS).toString() }] } };
  const ap = await call(st.g1, st.dao, 'add_proposal', { proposal: { description: 'Unfreeze Rescue Room vault after incident review', kind } }, { deposit: bond, gas: 100n * TGAS });
  const pid = ap.value;
  step('Guardian opened DAO proposal to unfreeze', { hash: ap.hash, note: `proposal ${pid}` });
  await call(st.g1, st.dao, 'act_proposal', { id: pid, action: 'VoteApprove', proposal: kind }, { gas: 200n * TGAS });
  const a2 = await call(st.g2, st.dao, 'act_proposal', { id: pid, action: 'VoteApprove', proposal: kind }, { gas: 200n * TGAS });
  await sleep(2000);
  step('DAO approved -> dao_unfreeze executed', { hash: a2.hash, note: `frozen now ${(await view(V, 'get_status')).frozen}` });
}

async function ethRescue() {
  // Beyond the ETH allowance -> held. Guardians rescue -> MPC signs a transfer to the DAO-controlled safe address.
  const to = '0x' + '22'.repeat(20);
  const { id, hash } = await request(st.owner, 'SepoliaEth', to, 5n * 10n ** 16n, 'large ETH transfer');
  step('0.05 ETH request beyond allowance -> held', { id, hash });
  const s = await scoreAndShow(id);
  step('Watcher scored it', { id, note: `score ${s.score.score}` });
  await call(st.g2, V, 'vote_rescue', { id }, { gas: 100n * TGAS });
  const v = await call(st.g3, V, 'vote_rescue', { id }, { gas: 300n * TGAS });
  step('Guardians g2 + g3 rescued -> MPC signs transfer to safe address', { id, hash: v.hash });
  const r = await waitFor(id, (x) => !!x.signature, 'rescue signature', 180_000);
  const f = finalize(r.evm_tx, r.signature);
  const cfg = await view(V, 'get_config');
  const ok = f.payloadMatches && f.from.toLowerCase() === st.vault_evm.toLowerCase() && r.evm_tx.to.toLowerCase() === cfg.safe_evm.toLowerCase();
  step('Rescue tx verified', { id, note: `to ${r.evm_tx.to} (safe), from ${f.from} (vault), ${ok ? 'OK' : 'MISMATCH'}` });
  if (!ok) throw new Error('rescue tx check failed');
  await daoUnfreeze();
}

async function coverPayout() {
  // Pay out the hot-allowance loss from the most recent agent attack.
  const reqs = await view(V, 'list_requests', { from_index: 0, limit: 100 });
  const loss = reqs.find((r) => r.hot && r.agent && r.status === 'Executed');
  if (!loss) throw new Error('no hot agent loss to claim; run attack first');
  const policy = (await view(V, 'list_policies')).find((x) => x.holder === st.owner && Number(x.end_ms) > Date.now() && x.paid_out === '0');
  if (!policy) throw new Error('no unused policy');
  const cl = await call(st.owner, V, 'file_claim', { policy_id: policy.id, amount: loss.amount, request_id: loss.id, reason: 'Hot allowance drained by stolen agent key' });
  step(`Owner filed cover claim for ${fmtNear(loss.amount)} NEAR lost in H-${String(loss.id).padStart(4, '0')}`, { hash: cl.hash });
  const c1 = await call(st.g1, V, 'vote_claim', { claim_id: cl.value });
  step('Guardian g1 approved claim', { hash: c1.hash });
  const c2 = await call(st.g3, V, 'vote_claim', { claim_id: cl.value });
  await sleep(2000);
  const claim = (await view(V, 'list_claims')).find((x) => x.id === cl.value);
  const stats = await view(V, 'cover_stats');
  step('Guardian g3 approved -> cover paid', { hash: c2.hash, note: `payout ${fmtNear(claim.payout)} NEAR (cap ${fmtNear(stats.per_incident_cap)}); pool ${fmtNear(stats.pool_balance)} NEAR; solvency ${(stats.solvency_bps / 100).toFixed(0)}%` });
}

async function attack() {
  // Buy cover first (premium priced by risk).
  let policyId = (await view(V, 'list_policies')).find((x) => x.holder === st.owner && Number(x.end_ms) > Date.now() && x.paid_out === '0')?.id;
  if (policyId === undefined) {
    const quote = await view(V, 'quote_premium', { coverage: near(1).toString() });
    const b = await call(st.main, V, 'cover_deposit', {}, { deposit: near(2) });
    step('Underwriter funded cover pool with 2 NEAR', { hash: b.hash });
    const p = await call(st.owner, V, 'buy_cover', { coverage: near(1).toString() }, { deposit: BigInt(quote) });
    step('Owner bought 1 NEAR of cover', { hash: p.hash, note: `premium ${fmtNear(quote)} NEAR` });
    policyId = p.value;
  }

  // Compromised agent key drains in chunks.
  const agent = await agentAccount();
  const status = await view(V, 'get_status');
  const hot = BigInt(status.near_hot_remaining);
  const chunks = [];
  if (hot > 0n) chunks.push(hot);
  chunks.push(near(0.5), near(2));
  const ids = [];
  for (const c of chunks) {
    const r = await request(agent, 'Near', st.attacker, c, 'ops payout');
    ids.push(r.id);
    step(`Attacker (stolen agent key) requested ${fmtNear(c)} NEAR`, { id: r.id, hash: r.hash });
  }
  const big = await scoreAndShow(ids[ids.length - 1]);
  step('Watcher scored the drain', { id: big.id, note: `score ${big.score?.score}, signals ${big.score?.signals.map((x) => x.code).join(',')}` });
  const v1 = await call(st.g1, V, 'vote_rescue', { id: big.id }, { gas: 100n * TGAS });
  step('Guardian g1 voted rescue', { hash: v1.hash });
  const v2 = await call(st.g2, V, 'vote_rescue', { id: big.id }, { gas: 100n * TGAS });
  step('Guardian g2 voted rescue -> quorum', { hash: v2.hash });
  const after = await view(V, 'get_status');
  const safeBal = await account(st.safe).getBalance();
  step('Rescued: vault frozen, funds at safe address', { note: `frozen ${after.frozen}; safe balance ${fmtNear(safeBal)} NEAR` });

  // Cover payout for what slipped through the hot allowance.
  if (hot > 0n) {
    const cl = await call(st.owner, V, 'file_claim', { policy_id: policyId, amount: hot.toString(), request_id: ids[0], reason: 'Hot allowance drained by stolen agent key' });
    step('Owner filed cover claim', { hash: cl.hash });
    await call(st.g1, V, 'vote_claim', { claim_id: cl.value });
    const c2 = await call(st.g3, V, 'vote_claim', { claim_id: cl.value });
    const claim = (await view(V, 'list_claims')).find((x) => x.id === cl.value);
    step('Guardians approved -> cover paid', { hash: c2.hash, note: `payout ${fmtNear(claim.payout)} NEAR; solvency ${(await view(V, 'cover_stats')).solvency_bps} bps` });
  }

  await daoUnfreeze();

  // Return rescued funds for the next demo run.
  const back = (await account(st.safe).getBalance()) - near(0.25);
  if (back > 0n) {
    const t = await account(st.safe).transfer({ receiverId: V, amount: back });
    step('Safe address returned funds to vault for the next demo', { hash: t.transaction.hash });
  }
}

const which = process.argv[2] || 'all';
const runs = { eth: ethSign, hot: hotSpend, falsealarm: falseAlarm, attack, cover: coverPayout, ethrescue: ethRescue };
try {
  for (const [k, fn] of Object.entries(runs)) if (which === 'all' || which === k) { console.log(`\n# ${k}`); await fn(); }
} finally {
  const out = path.join(ROOT, 'deploy', `e2e-${which}.json`);
  fs.writeFileSync(out, JSON.stringify(log.map((l) => ({ ...l, explorer: l.hash ? explorer(l.hash) : undefined })), null, 2));
  console.log(`\nlog: ${out}`);
}
