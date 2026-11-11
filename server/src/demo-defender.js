// Demo-mode guardians for one-click factory vaults. The factory registry marks these vaults demo: true and
// their guardians are Rescue Room's own test accounts (g1, g2, g3), run here. They vote to rescue held
// requests made by an agent key that score 60 or more, and unfreeze the vault two minutes after a rescue
// so the owner can try again. They never act on vaults that are not marked demo.
// Also revokes expired temporary agent keys on every factory vault (anyone may call that method).
const TGAS = 10n ** 12n;

export function startDemoDefender({ view, call, registry, guardians, revoker, busy = () => false, intervalMs = 4000, unfreezeAfterMs = 120_000, log = console.log }) {
  const frozenSince = new Map();
  const state = { last_tick: null, last_error: null, votes: 0, unfreezes: 0, revoked: 0 };
  let lastSweep = 0;
  let stopped = false;

  async function demoTick(info) {
    const V = info.vault;
    const s = await view(V, 'get_status');
    if (!s.guardians.every((g) => guardians.includes(g))) return; // guardians changed: not ours to run
    if (s.frozen) {
      if (!frozenSince.has(V)) frozenSince.set(V, Date.now());
      if (Date.now() - frozenSince.get(V) < unfreezeAfterMs) return;
      const votes = await view(V, 'get_unfreeze_votes').catch(() => []);
      for (const g of guardians.slice(0, s.approvals_needed)) {
        if (votes.includes(g)) continue;
        await call(g, V, 'vote_unfreeze', {}, { gas: 30n * TGAS });
        log(`demo: ${g.split('.')[0]} voted unfreeze on ${V}`);
      }
      frozenSince.delete(V);
      state.unfreezes++;
      return;
    }
    frozenSince.delete(V);
    if (busy(V)) return; // a live simulation is driving this vault
    const open = await view(V, 'list_open');
    if (!open.length) return;
    const reqs = await Promise.all(open.map((id) => view(V, 'get_request', { id })));
    const target = reqs.filter((r) => r.status === 'Held' && r.agent_pk && (r.score?.score ?? 0) >= 60).sort((a, b) => b.id - a.id)[0];
    if (!target) return;
    for (const g of guardians.slice(0, s.approvals_needed)) {
      if ((target.approvals || []).includes(g)) continue;
      await call(g, V, 'vote_rescue', { id: target.id }, { gas: 100n * TGAS });
      state.votes++;
      log(`demo: ${g.split('.')[0]} voted rescue on ${V} #${target.id}`);
    }
  }

  async function sweep() {
    const now = Date.now();
    for (const info of registry.all()) {
      const exp = await view(info.vault, 'get_agent_expiries').catch(() => []);
      if (exp.some(([, t]) => Number(t) <= now)) {
        const r = await call(revoker, info.vault, 'revoke_expired_agent_keys', {}, { gas: 50n * TGAS });
        state.revoked += (r.value || []).length;
        log(`revoked ${(r.value || []).length} expired agent key(s) on ${info.vault}`);
      }
    }
  }

  (async () => {
    while (!stopped) {
      try {
        for (const info of registry.all().filter((v) => v.demo)) await demoTick(info).catch((e) => log(`demo ${info.vault}: ${e.message.slice(0, 160)}`));
        if (Date.now() - lastSweep > 60_000) {
          lastSweep = Date.now();
          await sweep();
        }
        state.last_tick = Date.now();
        state.last_error = null;
      } catch (e) {
        state.last_error = e.message.slice(0, 200);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  })();
  return { state, stop: () => (stopped = true) };
}
