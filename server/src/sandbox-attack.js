// The public half of the attacker sandbox. It holds ONLY the sandbox agent key (a function-call key on
// the sandbox vault that can call request_withdraw and nothing else). It sends the scripted drain, then
// watches the chain while the defenders (watcher, guardians: server/src/sandbox-defender.js, run on the
// operator's machine) respond. No owner, guardian or DAO key is needed or accepted here.
const EXPLORER = process.env.NEAR_EXPLORER || 'https://testnet.nearblocks.io';
const YOCTO = 10n ** 24n;
const near = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 18n;
const fmt = (y) => (Number(BigInt(y) / 10n ** 20n) / 1e4).toFixed(4);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Busy extends Error {
  constructor(msg, retry = 30) {
    super(msg);
    this.retry_after_s = retry;
  }
}

/** Chain-level checks shared by every host: one run at a time, a global cooldown and a daily cap. */
export async function admission({ view, V, agentPk, cooldownS = 90, perDay = 40 }) {
  const status = await view(V, 'get_status');
  if (status.frozen) throw new Busy('the sandbox is resetting after the last rescue', 30);
  const agents = await view(V, 'get_agents');
  if (!agents.some(([pk]) => pk === agentPk)) throw new Busy('the sandbox agent key is being re-issued after the last rescue', 30);
  const from = Math.max(0, status.next_request_id - 150);
  const reqs = await view(V, 'list_requests', { from_index: from, limit: 150 });
  const mine = reqs.filter((r) => r.agent_pk === agentPk);
  const now = Date.now();
  const latest = Math.max(0, ...mine.map((r) => Number(r.created_ms)));
  if (now - latest < cooldownS * 1000) throw new Busy('a run started moments ago', Math.ceil((cooldownS * 1000 - (now - latest)) / 1000));
  const today = mine.filter((r) => now - Number(r.created_ms) < 86_400_000).length / 3;
  if (today >= perDay) throw new Busy('daily sandbox limit reached', 3600);
  if ((await view(V, 'list_open')).length) throw new Busy('a run is in progress', 30);
  return status;
}

/**
 * @param {object} o
 * @param {(e: object) => void} o.emit  stream sink
 * @param {Function} o.call    call(signer, contractId, method, args, {gas}) -> {hash, value}
 * @param {Function} o.view    view(contractId, method, args)
 * @param {Function} o.balance balance(accountId) -> bigint (view_account, no key)
 * @param {object} o.agent     signer for the sandbox agent key
 */
export async function runAttack({ emit, call, view, balance, agent, agentPk, V, safe, attacker, timeoutMs = 90_000, ...lim }) {
  const t0 = Date.now();
  const step = (label, data = {}) => emit({ type: 'step', at: Date.now() - t0, label, ...data, ...(data.hash ? { explorer: `${EXPLORER}/txns/${data.hash}` } : {}) });
  const status = await admission({ view, V, agentPk, ...lim });
  const startBal = BigInt(status.near_available);
  const hot = BigInt(status.near_hot_remaining);
  const safeBefore = await balance(safe);
  emit({ type: 'start', vault: V, reserve: startBal.toString(), hot_allowance: hot.toString() });
  step(`Sandbox vault ready: ${fmt(startBal)} NEAR available, hot allowance ${fmt(hot)} NEAR`);
  step('Attacker holds a stolen agent key: it can only call request_withdraw');

  const chunks = [...(hot > 0n ? [hot] : []), near(0.5), near(2)];
  const ids = [];
  for (const c of chunks) {
    const r = await call(agent, V, 'request_withdraw', { asset: 'Near', to: attacker, amount: c.toString(), memo: 'ops payout' }, { gas: 100n * 10n ** 12n });
    ids.push(r.value);
    const req = await view(V, 'get_request', { id: r.value });
    step(`Attacker requested ${fmt(c)} NEAR`, { id: r.value, hash: r.hash, outcome: req.hot ? 'paid' : 'held', note: req.hot ? 'inside the hot allowance: paid instantly' : 'beyond the allowance: held for scoring' });
  }

  let scored = false;
  const voted = new Set();
  let rescued = null;
  while (Date.now() - t0 < timeoutMs) {
    const all = await Promise.all(ids.map((id) => view(V, 'get_request', { id })));
    const r = all.find((x) => x.status === 'Rescued') || all.find((x) => x.approvals?.length) || all.at(-1);
    if (r.score && !scored) {
      scored = true;
      step(`Watcher scored the drain ${r.score.score}/100`, { id: r.id, note: r.score.signals.map((s) => s.code).join(', '), score: r.score.score, release_ms: r.release_ms });
    }
    for (const g of r.approvals || []) {
      if (voted.has(g)) continue;
      voted.add(g);
      step(`Guardian ${g.split('.')[0]} voted rescue${voted.size >= 2 ? ': quorum reached' : ''}`);
    }
    if (r.status === 'Rescued') {
      rescued = r;
      break;
    }
    await sleep(2000);
  }
  const reqs = await Promise.all(ids.map((id) => view(V, 'get_request', { id })));
  const lost = reqs.filter((r) => r.hot && r.status === 'Executed').reduce((a, r) => a + BigInt(r.amount), 0n);
  let kept = 0n;
  if (rescued) {
    for (let i = 0; i < 8; i++) {
      kept = (await balance(safe)) - safeBefore;
      if (kept > 0n) break;
      await sleep(1500);
    }
    step(`Rescued: ${fmt(kept > 0n ? kept : 0n)} NEAR moved to the safe account, vault frozen, agent key revoked`);
  } else {
    const held = reqs.filter((r) => !r.hot).reduce((a, r) => a + BigInt(r.amount), 0n);
    step(`Guardians did not respond within ${Math.round(timeoutMs / 1000)}s. The ${fmt(held)} NEAR drain stays held, so it cannot pay out until the hold ends; a guardian can still rescue it.`);
  }
  const after = await view(V, 'get_status');
  const result = {
    hot_lost: lost.toString(),
    reserve_kept: (rescued ? (kept > 0n ? kept : 0n) : BigInt(after.near_available)).toString(),
    attempted: chunks.reduce((a, c) => a + c, 0n).toString(),
    rescued: !!rescued,
    frozen: after.frozen,
    statuses: reqs.map((r) => ({ id: r.id, amount: r.amount, status: r.status, hot: r.hot })),
  };
  emit({ type: 'result', ...result });
  step('The operator resets the sandbox for the next visitor (DAO unfreeze, refunds, new agent key)');
  emit({ type: 'done', ms: Date.now() - t0 });
  return result;
}
export { YOCTO };
