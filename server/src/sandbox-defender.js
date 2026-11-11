// The privileged half of the attacker sandbox. Runs on the operator's machine (never in a public
// function): it scores held requests, has two guardians vote rescue on agent-made drains, and resets
// the sandbox afterwards (DAO unfreeze, refunds, re-adds the same request-only agent key).
import { account, call, view, loadState, loadKeyPair, hasKey, newKey, near, fmtNear, TGAS } from '../../scripts/lib/near.js';
import { tick as watcherTick } from '../../watcher/src/watcher.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function sandboxAgentKeyId(V) {
  return `agent-key-${V}`;
}

export function startDefender({ intervalMs = 3000, log = (m) => console.log(`sandbox defender: ${m}`) } = {}) {
  const st = loadState();
  if (!st.sandbox?.vault) return null;
  const V = st.sandbox.vault;
  const SAFE = st.sandbox.safe;
  const keyId = sandboxAgentKeyId(V);
  if (!hasKey(keyId)) {
    if (process.env.RR_KEYS) throw new Error(`missing ${keyId} in RR_KEYS`);
    newKey(keyId);
  }
  const agentPk = loadKeyPair(keyId).getPublicKey().toString();
  let frozenSince = 0;
  let busy = false;
  let stopped = false;
  const state = { vault: V, agent_pk: agentPk, last_tick: null, last_error: null, resets: 0 };

  async function unfreeze() {
    const bond = BigInt((await view(st.dao, 'get_policy')).proposal_bond);
    const kind = { FunctionCall: { receiver_id: V, actions: [{ method_name: 'dao_unfreeze', args: Buffer.from('{}').toString('base64'), deposit: '0', gas: (30n * TGAS).toString() }] } };
    const ap = await call(st.g1, st.dao, 'add_proposal', { proposal: { description: 'Sandbox reset: unfreeze after attacker run', kind } }, { deposit: bond, gas: 100n * TGAS });
    await call(st.g1, st.dao, 'act_proposal', { id: ap.value, action: 'VoteApprove', proposal: kind }, { gas: 200n * TGAS });
    await call(st.g2, st.dao, 'act_proposal', { id: ap.value, action: 'VoteApprove', proposal: kind }, { gas: 200n * TGAS });
    log(`DAO proposal ${ap.value} unfroze ${V}`);
  }

  async function refund() {
    for (const [who, keep] of [[SAFE, near(0.2)], [st.attacker, near(1)]]) {
      const back = (await account(who).getBalance()) - keep;
      if (back > near(0.01)) {
        await account(who).transfer({ receiverId: V, amount: back });
        log(`${who.split('.')[0]} returned ${fmtNear(back)} NEAR`);
      }
    }
  }

  async function tick() {
    const s = await view(V, 'get_status');
    if (s.frozen) {
      frozenSince ||= Date.now();
      // Give the public stream time to read the rescue before resetting.
      if (Date.now() - frozenSince < 15_000) return;
      await unfreeze();
      frozenSince = 0;
      state.resets++;
      return;
    }
    frozenSince = 0;
    const open = await view(V, 'list_open');
    if (open.length) {
      const reqs = await Promise.all(open.map((id) => view(V, 'get_request', { id })));
      if (reqs.some((r) => r.status === 'PendingScore')) await watcherTick(V);
      // Vote on the newest qualifying drain only: one rescue sweeps the whole reserve.
      const target = reqs.filter((r) => r.status === 'Held' && r.agent_pk === agentPk && (r.score?.score ?? 0) >= 60).sort((a, b) => b.id - a.id).slice(0, 1);
      for (const r of target) {
        for (const g of [st.g1, st.g2]) {
          if ((r.approvals || []).includes(g)) continue;
          await call(g, V, 'vote_rescue', { id: r.id }, { gas: 100n * TGAS });
          log(`${g.split('.')[0]} voted rescue on #${r.id}`);
          await sleep(1500);
        }
      }
      return;
    }
    if (!(await view(V, 'get_agents')).some(([pk]) => pk === agentPk)) {
      await call(st.sandbox.owner || st.owner, V, 'add_agent_key', { public_key: agentPk, label: 'sandbox-agent' }, { deposit: 1n, gas: 100n * TGAS });
      log('re-issued the request-only agent key');
      return;
    }
    await refund();
  }

  (async () => {
    while (!stopped) {
      if (!busy) {
        busy = true;
        try {
          await tick();
          state.last_tick = Date.now();
          state.last_error = null;
        } catch (e) {
          state.last_error = e.message;
          log(`error: ${e.message}`);
        }
        busy = false;
      }
      await sleep(intervalMs);
    }
  })();
  return { state, stop: () => (stopped = true), V, SAFE, agentPk, keyId, attacker: st.attacker };
}
