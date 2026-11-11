import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPatterns, freshFindings } from '../src/patterns.js';

const N = 10n ** 24n;
const cfg = { near_allowance: { limit: (1n * N).toString(), window_secs: 86400 }, demo_time_divisor: 1, safe_near: 'safe.testnet' };
const now = 1_800_000_000_000;
const req = (id, minsAgo, amount, to = 'x.testnet', extra = {}) => ({ id, asset: 'Near', hot: true, status: 'Executed', to, amount: amount.toString(), created_ms: String(now - minsAgo * 60_000), ...extra });

test('burst: five small hot spends within 10 minutes fire, one rule per shape', () => {
  const requests = [1, 2, 3, 4, 5].map((i) => req(i, 9 - i, N / 20n));
  const f = detectPatterns({ requests, config: cfg, now });
  assert.ok(f.some((x) => x.rule === 'burst' && x.ids.length === 5));
  assert.ok(f.some((x) => x.rule === 'repeat_recipient'), 'repeated spends to a new recipient also flag');
  assert.equal(freshFindings(f, { now }).length, f.length);
});

test('burst by share: 60% of the allowance within an hour', () => {
  const f = detectPatterns({ requests: [req(1, 50, (N * 3n) / 10n, 'a.testnet'), req(2, 10, (N * 35n) / 100n, 'b.testnet')], config: cfg, now });
  assert.deepEqual(f.map((x) => x.rule), ['burst']);
});

test('drip: allowance mostly used three windows in a row; quiet vault and known recipients stay silent', () => {
  const day = 24 * 60;
  const requests = [0, 1, 2].map((k) => req(k + 1, k * day + 60, (N * 85n) / 100n, 'safe.testnet'));
  const f = detectPatterns({ requests, config: cfg, now });
  assert.deepEqual(f.map((x) => x.rule), ['drip']);
  assert.equal(freshFindings(f, { now }).length, 0, 'old activity is not paged');
  assert.deepEqual(detectPatterns({ requests: [req(1, 30, N / 10n, 'safe.testnet')], config: cfg, now }), []);
  assert.deepEqual(detectPatterns({ requests: [1, 2, 3].map((i) => req(i, 30 + i * 30, N / 20n, 'vendor.testnet')), config: cfg, whitelist: ['vendor.testnet'], now }), []);
});

test('held and rescued requests do not count', () => {
  const requests = [1, 2, 3, 4, 5].map((i) => req(i, 1, N / 20n, 'x.testnet', { hot: i > 3, status: i === 5 ? 'Rescued' : 'Executed' }));
  assert.deepEqual(detectPatterns({ requests, config: cfg, now }), []);
});
