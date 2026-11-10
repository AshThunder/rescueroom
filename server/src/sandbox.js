// Attacker sandbox: runs the scripted chunked drain against the sandbox vault (testnet), streams each
// step, then resets the vault (DAO unfreeze, safe and attacker return funds) for the next visitor.
import { Account, KeyPairSigner } from 'near-api-js';
import { account, call, view, loadState, newKey, loadKeyPair, hasKey, provider, near, fmtNear, TGAS } from '../../scripts/lib/near.js';
import { tick as watcherTick } from '../../watcher/src/watcher.js';

const EXPLORER = process.env.NEAR_EXPLORER || 'https://testnet.nearblocks.io';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function sandboxConfig() {
  const st = loadState();
  if (!st.sandbox?.vault) return null;
  return { st, V: st.sandbox.vault, SAFE: st.sandbox.safe };
}

export async function runSandbox(emit) {
  const cfg = sandboxConfig();
  if (!cfg) throw new Error('sandbox vault not deployed (VAULT_ROLE=sandbox node scripts/deploy.mjs)');
  const { st, V, SAFE } = cfg;
  const t0 = Date.now();
  const step = (label, data = {}) => emit({ type: 'step', at: Date.now() - t0, label, ...data, ...(data.hash ? { explorer: `${EXPLORER}/txns/${data.hash}` } : {}) });

  // Preflight: a previous run may have been interrupted mid-reset.
  let status = await view(V, 'get_status');
  if (status.frozen) {
    step('Vault was left frozen by an earlier run; unfreezing first');
    await unfreeze(st, V, step);
  }
  await refund(st, V, SAFE, step, true);
  status = await view(V, 'get_status');
  const startBal = BigInt(status.near_available);
  const hot = BigInt(status.near_hot_remaining);
  emit({ type: 'start', vault: V, reserve: startBal.toString(), hot_allowance: hot.toString() });
  step(`Sandbox vault ready: ${fmtNear(startBal)} NEAR available, hot allowance ${fmtNear(hot)} NEAR`);

  // The attacker holds a stolen agent key: a function-call key that can only call request_withdraw.
  const keyId = `agent-key-${V}`;
  if (!hasKey(keyId)) {
    const pk = newKey(keyId);
    const r = await call(st.owner, V, 'add_agent_key', { public_key: pk, label: 'sandbox-agent' }, { deposit: 1n, gas: 100n * TGAS });
    step('Owner issued the agent a request-only key', { hash: r.hash });
  } else if (!(await view(V, 'get_agents')).some(([pk]) => pk === loadKeyPair(keyId).getPublicKey().toString())) {
    // Revoked by the previous rescue: issue a fresh one.
    const pk = newKey(keyId);
    const r = await call(st.owner, V, 'add_agent_key', { public_key: pk, label: 'sandbox-agent' }, { deposit: 1n, gas: 100n * TGAS });
    step('Owner re-issued the agent key (last run revoked it)', { hash: r.hash });
    await sleep(1500);
  }
  const agent = new Account(V, provider, new KeyPairSigner(loadKeyPair(keyId)));

  const chunks = [...(hot > 0n ? [hot] : []), near(0.5), near(2)];
  const ids = [];
  for (const c of chunks) {
    const r = await call(agent, V, 'request_withdraw', { asset: 'Near', to: st.attacker, amount: c.toString(), memo: 'ops payout' }, { gas: 100n * TGAS });
    ids.push(r.value);
    const req = await view(V, 'get_request', { id: r.value });
    step(`Attacker requested ${fmtNear(c)} NEAR`, { id: r.value, hash: r.hash, outcome: req.hot ? 'paid' : 'held', note: req.hot ? 'inside the hot allowance: paid instantly' : 'beyond the allowance: held for scoring' });
  }

  // Watcher scores (and signs evidence for) every held request.
  const last = ids[ids.length - 1];
  let scored;
  for (let i = 0; i < 20 && !scored; i++) {
    await watcherTick(V);
    const r = await view(V, 'get_request', { id: last });
    if (r.score) scored = r;
    else await sleep(1500);
  }
  if (!scored) throw new Error('watcher did not score in time');
  step(`Watcher scored the drain ${scored.score.score}/100`, { id: last, note: scored.score.signals.map((s) => s.code).join(', '), score: scored.score.score, release_ms: scored.release_ms });

  const v1 = await call(st.g1, V, 'vote_rescue', { id: last }, { gas: 100n * TGAS });
  step('Guardian g1 voted rescue', { hash: v1.hash });
  const safeBefore = await account(SAFE).getBalance();
  const v2 = await call(st.g2, V, 'vote_rescue', { id: last }, { gas: 100n * TGAS });
  step('Guardian g2 voted rescue: quorum reached', { hash: v2.hash });
  await sleep(2500);
  const safeAfter = await account(SAFE).getBalance();
  const after = await view(V, 'get_status');
  const reqs = await Promise.all(ids.map((id) => view(V, 'get_request', { id })));
  const lost = reqs.filter((r) => r.hot && r.status === 'Executed').reduce((a, r) => a + BigInt(r.amount), 0n);
  const kept = safeAfter - safeBefore;
  const result = {
    hot_lost: lost.toString(),
    reserve_kept: (kept > 0n ? kept : 0n).toString(),
    attempted: chunks.reduce((a, c) => a + c, 0n).toString(),
    frozen: after.frozen,
    statuses: reqs.map((r) => ({ id: r.id, amount: r.amount, status: r.status, hot: r.hot })),
  };
  step(`Rescued: ${fmtNear(kept)} NEAR moved to the safe account, vault frozen, agent key revoked`, { hash: v2.hash });
  emit({ type: 'result', ...result });

  // Reset for the next visitor.
  await unfreeze(st, V, step);
  await refund(st, V, SAFE, step);
  emit({ type: 'done', ms: Date.now() - t0 });
  return result;
}

async function unfreeze(st, V, step) {
  const bond = BigInt((await view(st.dao, 'get_policy')).proposal_bond);
  const kind = { FunctionCall: { receiver_id: V, actions: [{ method_name: 'dao_unfreeze', args: Buffer.from('{}').toString('base64'), deposit: '0', gas: (30n * TGAS).toString() }] } };
  const ap = await call(st.g1, st.dao, 'add_proposal', { proposal: { description: 'Sandbox reset: unfreeze after attacker run', kind } }, { deposit: bond, gas: 100n * TGAS });
  await call(st.g1, st.dao, 'act_proposal', { id: ap.value, action: 'VoteApprove', proposal: kind }, { gas: 200n * TGAS });
  const a2 = await call(st.g2, st.dao, 'act_proposal', { id: ap.value, action: 'VoteApprove', proposal: kind }, { gas: 200n * TGAS });
  step(`Reset: DAO proposal ${ap.value} unfroze the vault`, { hash: a2.hash });
}

async function refund(st, V, SAFE, step, preflight = false) {
  for (const [who, keep] of [[SAFE, near(0.2)], [st.attacker, near(1)]]) {
    const bal = await account(who).getBalance();
    const back = bal - keep;
    if (back > near(0.01)) {
      const t = await account(who).transfer({ receiverId: V, amount: back });
      step(`${preflight ? 'Preflight' : 'Reset'}: ${who.split('.')[0]} returned ${fmtNear(back)} NEAR to the sandbox vault`, { hash: t.transaction.hash });
    }
  }
}
