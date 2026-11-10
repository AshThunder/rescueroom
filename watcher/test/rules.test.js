import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreRequest } from '../src/rules.js';

const N = 10n ** 24n;
const DAY = 86_400_000;
const base = { whitelist: new Map(), availableNear: 10n * N, allowance: 1n * N, windowMs: DAY, nowMs: 0, usualHoursUtc: [0, 24], freshWhitelistMs: DAY };
const r = (id, o) => ({ id, asset: 'Near', to: 'vendor.testnet', amount: (1n * N).toString(), requester: 'owner.testnet', agent: null, status: 'Executed', created_ms: String(id * 10 * DAY), ...o });

test('known destination, normal size scores low', () => {
  const hist = [r(0), r(1), r(2), r(3)];
  const out = scoreRequest(r(4, { status: 'PendingScore' }), hist, base);
  assert.equal(out.score, 0);
});

test('new destination is flagged', () => {
  const hist = [r(0), r(1), r(2)];
  const out = scoreRequest(r(3, { to: 'new.testnet', status: 'PendingScore' }), hist, base);
  assert.ok(out.signals.some((s) => s.code === 'new_destination'));
  assert.ok(out.score >= 30);
});

test('stolen agent key chunked drain scores critical', () => {
  const t = 100 * DAY;
  const hist = [r(0), r(1), r(2), r(3)];
  const a = (id, amt) => ({ ...r(id), to: 'attacker.testnet', agent: 'ops-agent', requester: 'vault', amount: (amt * N).toString(), created_ms: String(t + id) });
  hist.push(a(5, 1n), a(6, 1n));
  const out = scoreRequest({ ...a(7, 6n), status: 'PendingScore' }, hist, base);
  assert.ok(out.score >= 80, `score ${out.score}`);
  for (const c of ['new_destination', 'chunked_drain', 'large_share_of_reserve', 'signing_pattern_change', 'agent_unlisted_destination']) {
    assert.ok(out.signals.some((s) => s.code === c), c);
  }
});

test('cancelled requests do not count toward chunking', () => {
  const t = 100 * DAY;
  const hist = [r(0), r(1, { status: 'Cancelled', created_ms: String(t) }), r(2, { status: 'Cancelled', created_ms: String(t + 1) })];
  const out = scoreRequest(r(3, { created_ms: String(t + 2), status: 'PendingScore' }), hist, base);
  assert.ok(!out.signals.some((s) => s.code === 'chunked_drain'));
});

test('fresh whitelist still carries risk; old whitelist lowers it', () => {
  const t = 100 * DAY;
  const fresh = { ...base, whitelist: new Map([['vendor2.testnet', t - 1000]]) };
  const a = scoreRequest(r(1, { to: 'vendor2.testnet', created_ms: String(t) }), [r(0)], fresh);
  assert.ok(a.signals.some((s) => s.code === 'fresh_whitelist'));
  const old = { ...base, whitelist: new Map([['vendor2.testnet', t - 2 * DAY]]) };
  const b = scoreRequest(r(1, { to: 'vendor2.testnet', created_ms: String(t) }), [r(0)], old);
  assert.ok(b.rawSignals.some((s) => s.code === 'trusted_destination'));
  assert.ok(b.score <= a.score);
});
