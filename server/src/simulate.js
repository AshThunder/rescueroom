// "Simulate an attack on my vault" (hosted defender). The defender makes a fresh key pair and returns
// only its public key; the vault owner signs add_agent_key(public_key, "attack-sim", ttl_secs) in their
// wallet. The key can only call request_withdraw and expires on its own. The private key never leaves
// this process. The run streams each step: allowance spend, held drain, score and explanation, and the
// response (demo guardians rescue; otherwise the owner's guardians or the owner decide).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Account, KeyPair, KeyPairSigner } from 'near-api-js';

const EXPLORER = process.env.NEAR_EXPLORER || 'https://testnet.nearblocks.io';
const TGAS = 10n ** 12n;
const fmt = (y) => (Number(BigInt(y) / 10n ** 20n) / 1e4).toFixed(4);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const SIM_TTL_SECS = 600;
const MIN_AVAILABLE = 3n * 10n ** 23n; // 0.3 NEAR

export class SimError extends Error {
  constructor(msg, code = 409, retry = 0) {
    super(msg);
    this.code = code;
    this.retry_after_s = retry;
  }
}

export function createSimulator({ view, call, transfer, provider, registry, attacker, demoGuardians, scoreVault, checkPatterns, evidenceDir, app, limits = {}, log = console.log }) {
  const perVaultS = limits.perVaultS ?? 180;
  const perIpHour = limits.perIpHour ?? 6;
  const perDay = limits.perDay ?? 80;
  const sims = new Map();
  const lastByVault = new Map();
  const ipHits = new Map();
  const day = { start: Date.now(), n: 0 };
  const active = new Set();

  function rate(ip, vault) {
    const now = Date.now();
    if (now - day.start > 86_400_000) Object.assign(day, { start: now, n: 0 });
    if (day.n >= perDay) throw new SimError('daily simulation limit reached; try tomorrow', 429, 3600);
    const hits = (ipHits.get(ip) || []).filter((t) => now - t < 3_600_000);
    if (hits.length >= perIpHour) throw new SimError(`limit ${perIpHour} simulations per hour`, 429, Math.ceil((3_600_000 - (now - hits[0])) / 1000));
    const last = lastByVault.get(vault) || 0;
    if (now - last < perVaultS * 1000) throw new SimError('this vault ran a simulation moments ago', 429, Math.ceil((perVaultS * 1000 - (now - last)) / 1000));
    if (active.has(vault)) throw new SimError('a simulation is running on this vault', 409, 30);
    return { take: () => (ipHits.set(ip, [...hits, now]), lastByVault.set(vault, now), day.n++) };
  }

  async function prepare({ vault, ip, mode = 'drain' }) {
    const info = registry.get(vault) || (await registry.refresh(), registry.get(vault));
    if (!info) throw new SimError('only vaults created by the Rescue Room factory can be simulated', 400);
    const s = await view(vault, 'get_status');
    if (s.frozen) throw new SimError('the vault is frozen after a rescue; unfreeze it first', 409);
    if (BigInt(s.near_available) < MIN_AVAILABLE) throw new SimError(`fund the vault first: it needs at least ${fmt(MIN_AVAILABLE)} NEAR available (has ${fmt(s.near_available)})`, 409);
    if ((await view(vault, 'list_open')).length) throw new SimError('the vault has open holds; resolve them first', 409);
    const r = rate(ip, vault);
    for (const [k, v] of sims) if (Date.now() - v.created > 15 * 60_000) sims.delete(k);
    const kp = KeyPair.fromRandom('ed25519');
    const id = crypto.randomUUID().slice(0, 12);
    sims.set(id, { id, vault, kp, created: Date.now(), ip, take: r.take, info, mode });
    const pk = kp.getPublicKey().toString();
    return { sim: id, vault, mode, public_key: pk, ttl_secs: SIM_TTL_SECS, call: { receiver: vault, method: 'add_agent_key', args: { public_key: pk, label: 'attack-sim', ttl_secs: SIM_TTL_SECS }, deposit: '1', gas: (100n * TGAS).toString() } };
  }

  async function run(id, emit) {
    const sim = sims.get(id);
    if (!sim) throw new SimError('unknown or expired simulation; prepare a new one', 404);
    if (sim.started) throw new SimError('this simulation already ran', 409);
    const V = sim.vault;
    if (active.has(V)) throw new SimError('a simulation is running on this vault', 409, 30);
    sim.started = true;
    active.add(V);
    const t0 = Date.now();
    const step = (label, data = {}) => emit({ type: 'step', at: Date.now() - t0, label, ...data, ...(data.hash ? { explorer: `${EXPLORER}/txns/${data.hash}` } : {}) });
    const pk = sim.kp.getPublicKey().toString();
    try {
      // Wait for the owner's add_agent_key to land.
      let ok = false;
      for (let i = 0; i < 20 && !ok; i++) {
        ok = (await view(V, 'get_agents')).some(([k]) => k === pk);
        if (!ok) await sleep(1500);
      }
      if (!ok) throw new SimError('the attacker key was not found on the vault; sign add_agent_key first', 409);
      sim.take();
      const cfg = await view(V, 'get_config');
      const status = await view(V, 'get_status');
      const demo = !!sim.info.demo;
      emit({ type: 'start', vault: V, demo, reserve: status.near_available, hot_allowance: status.near_hot_remaining });
      step(`Owner granted a temporary attacker key: request_withdraw only, expires in ${SIM_TTL_SECS / 60} min`, { note: pk.slice(0, 20) + '…' });
      const agent = new Account(V, provider, new KeyPairSigner(sim.kp));
      if (sim.mode === 'batch') return await smallBatch({ sim, V, cfg, status, agent, step, emit, t0, pk });
      const hot = BigInt(status.near_hot_remaining);
      let avail = BigInt(status.near_available);
      const ids = [];
      const hotSpends = [];
      // 1) Spend the hot allowance in two chunks (paid instantly, loss capped by the allowance).
      const h1 = (hot < avail ? hot : avail) * 6n / 10n;
      const h2 = (hot < avail ? hot : avail) * 4n / 10n;
      for (const c of [h1, h2].filter((x) => x > 10n ** 21n)) {
        const r = await call(agent, V, 'request_withdraw', { asset: 'Near', to: attacker, amount: c.toString(), memo: 'ops payout (simulated attack)' }, { gas: 100n * TGAS });
        ids.push(r.value);
        const req = await view(V, 'get_request', { id: r.value });
        if (req.hot) hotSpends.push(c);
        step(`Attacker requested ${fmt(c)} NEAR`, { id: r.value, hash: r.hash, outcome: req.hot ? 'paid' : 'held', note: req.hot ? 'inside the hot allowance: paid at once' : 'held' });
      }
      // 2) The drain: most of what is left. Beyond the allowance, so it is held.
      await sleep(1500);
      avail = BigInt((await view(V, 'get_status')).near_available);
      const drain = avail * 9n / 10n;
      const d = await call(agent, V, 'request_withdraw', { asset: 'Near', to: attacker, amount: drain.toString(), memo: 'treasury migration' }, { gas: 100n * TGAS });
      ids.push(d.value);
      step(`Attacker tried to drain ${fmt(drain)} NEAR`, { id: d.value, hash: d.hash, outcome: 'held', note: 'beyond the allowance: held before it can pay out' });
      // 3) Score + explanation (the defender's watcher, signed evidence published on chain).
      let req;
      for (let i = 0; i < 30; i++) {
        await scoreVault(V).catch(() => {});
        req = await view(V, 'get_request', { id: d.value });
        if (req.score) break;
        await sleep(2000);
      }
      if (req?.score) {
        let explanation = null;
        try {
          explanation = JSON.parse(fs.readFileSync(path.join(evidenceDir, `${V}-${d.value}.json`), 'utf8')).bundle.explanation;
        } catch {}
        step(`Watcher scored the drain ${req.score.score}/100 and held it until ${new Date(Number(req.release_ms)).toISOString().slice(11, 16)} UTC`, { id: d.value, score: req.score.score, note: req.score.signals.map((s) => s.code).join(', '), release_ms: req.release_ms });
        if (explanation) emit({ type: 'explanation', id: d.value, provider: explanation.provider, text: explanation.text });
      } else step('The watcher has not scored yet; the request stays held at the longest hold');
      const links = { hold: `${app}/app/holds/${d.value}?vault=${encodeURIComponent(V)}`, rescue: `${app}/app/sign/rescue/${d.value}?vault=${encodeURIComponent(V)}`, cancel: `${app}/app/sign/cancel/${d.value}?vault=${encodeURIComponent(V)}` };
      // 4) Response.
      let final = req;
      if (demo && req?.score && req.score.score >= 60) {
        step('Demo mode: the demo guardians run by Rescue Room vote to rescue');
        for (const g of demoGuardians.slice(0, Number(cfg.min_distinct) || 2)) {
          try {
            const v = await call(g, V, 'vote_rescue', { id: d.value }, { gas: 100n * TGAS });
            step(`Demo guardian ${g.split('.')[0]} voted rescue`, { hash: v.hash });
          } catch (e) {
            if (!/already voted|not on hold/.test(e.message)) throw e;
          }
        }
      } else {
        step(demo ? 'Score below the demo auto-rescue threshold: your guardians or you decide' : 'Your guardians can vote to rescue, or you can cancel. Waiting up to 2 minutes', { links });
        emit({ type: 'decide', id: d.value, links });
      }
      for (let i = 0; i < (demo ? 15 : 60); i++) {
        final = await view(V, 'get_request', { id: d.value });
        if (!['PendingScore', 'Held'].includes(final.status)) break;
        await sleep(2000);
      }
      const after = await view(V, 'get_status');
      if (final.status === 'Rescued') step(`Rescued: the reserve moved to ${cfg.safe_near}, open requests were cancelled, the attacker key was revoked and the vault is frozen`, { id: d.value });
      else if (final.status === 'Cancelled') step('Cancelled by the owner: nothing moved', { id: d.value });
      else step(`Still held (status ${final.status}). It cannot pay out before ${new Date(Number(final.release_ms)).toISOString().slice(11, 16)} UTC; a guardian can still rescue it`, { links });
      // 5) Give back what the allowance let through, so a simulation costs the owner nothing.
      const back = hotSpends.reduce((a, c) => a + c, 0n);
      if (back > 0n) {
        const to = final.status === 'Rescued' ? cfg.safe_near : V;
        try {
          const t = await transfer(attacker, to, back);
          step(`Rescue Room returned the ${fmt(back)} NEAR the allowance let through to ${to}`, { hash: t.hash });
        } catch (e) {
          step(`Could not return the allowance spend yet: ${e.message.slice(0, 80)}`);
        }
      }
      const agents = await view(V, 'get_agents');
      const keyLeft = agents.some(([k]) => k === pk);
      if (keyLeft) {
        const exp = (await view(V, 'get_agent_expiries').catch(() => [])).find(([k]) => k === pk)?.[1];
        step(`The attacker key expires at ${exp ? new Date(Number(exp)).toISOString().slice(11, 16) + ' UTC' : 'its time limit'} and the defender revokes it then`);
      } else step('The attacker key is already revoked on chain');
      emit({ type: 'result', rescued: final.status === 'Rescued', status: final.status, hot_lost: '0', drain: drain.toString(), frozen: after.frozen, key_revoked: !keyLeft, request: d.value, links });
      emit({ type: 'done', ms: Date.now() - t0 });
    } finally {
      active.delete(V);
      log(`simulate ${V}: done in ${Date.now() - t0} ms`);
    }
  }

  // "Small batch drain": stay inside the allowance with many small instant spends, so nothing is held.
  // The off-chain pattern rules flag it and recommend tightening the allowance or removing the key.
  async function smallBatch({ sim, V, cfg, status, agent, step, emit, t0, pk }) {
    const hot = BigInt(status.near_hot_remaining);
    const avail = BigInt(status.near_available);
    const each = ((hot < avail ? hot : avail) * 15n) / 100n;
    if (each < 10n ** 21n) throw new SimError('the hot allowance is used up for this window; try the batch run later', 409);
    step('Small batch drain: the attacker stays inside the hot allowance so no single request is held');
    const spends = [];
    for (let i = 0; i < 5; i++) {
      const r = await call(agent, V, 'request_withdraw', { asset: 'Near', to: attacker, amount: each.toString(), memo: `refund ${i + 1}/5` }, { gas: 100n * TGAS });
      const req = await view(V, 'get_request', { id: r.value });
      if (req.hot) spends.push(each);
      step(`Attacker requested ${fmt(each)} NEAR`, { id: r.value, hash: r.hash, outcome: req.hot ? 'paid' : 'held', note: req.hot ? 'small and inside the allowance: paid at once' : 'held' });
    }
    const found = checkPatterns ? await checkPatterns(V).catch((e) => (step(`Pattern check failed: ${e.message.slice(0, 80)}`), [])) : [];
    for (const f of found) {
      step(`Pattern alert: ${f.title}`, { outcome: 'flagged', note: f.evidence });
      emit({ type: 'pattern', rule: f.rule, title: f.title, evidence: f.evidence, suggestion: f.suggestion, delivery: f.alert?.delivery });
    }
    if (!found.length) step('No pattern fired (the allowance may be too small for the rules)');
    step('Recommendation only: Rescue Room never tightens the allowance or removes keys for you');
    const back = spends.reduce((a, c) => a + c, 0n);
    if (back > 0n) {
      try {
        const t = await transfer(attacker, V, back);
        step(`Rescue Room returned the ${fmt(back)} NEAR to the vault`, { hash: t.hash });
      } catch (e) {
        step(`Could not return the spends yet: ${e.message.slice(0, 80)}`);
      }
    }
    step('The attacker key expires within 10 minutes and the defender revokes it then');
    emit({ type: 'result', mode: 'batch', rescued: false, status: found.length ? 'Flagged' : 'Not flagged', patterns: found.length, hot_lost: '0', frozen: false, key_revoked: false });
    emit({ type: 'done', ms: Date.now() - t0 });
  }

  return { prepare, run, state: () => ({ active: [...active], today: day.n, limits: { perVaultS, perIpHour, perDay } }) };
}
