import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter } from '../src/ratelimit.js';
import { parseEvents } from '../src/indexer.js';

test('sandbox limiter: per-client window and daily cap', () => {
  const l = createLimiter({ perClient: 2, windowMs: 60_000, perDay: 3 });
  for (let i = 0; i < 2; i++) {
    assert.ok(l.check('a').ok);
    l.take('a');
  }
  const r = l.check('a');
  assert.equal(r.ok, false);
  assert.ok(r.retry_after_s > 0 && r.retry_after_s <= 60);
  assert.ok(l.check('b').ok);
  l.take('b');
  assert.equal(l.check('c').ok, false, 'daily cap reached');
});

test('indexer keeps only rescueroom events emitted by the watched account', () => {
  const log = (event, data) => `EVENT_JSON:${JSON.stringify({ standard: 'rescueroom', version: '1.0.0', event, data: [data] })}`;
  const tx = {
    transaction: { hash: 'H', signer_id: 'g1.t' },
    receipts: [
      { execution_outcome: { id: 'R1', block_height: 10, block_timestamp: '1700000000000000000', outcome: { executor_id: 'v.t', logs: [log('rescue_vote', { id: 1 }), 'plain log', 'EVENT_JSON:{bad'] } }, receipt: { predecessor_id: 'g1.t' } },
      { execution_outcome: { id: 'R2', block_height: 11, block_timestamp: '1700000001000000000', outcome: { executor_id: 'other.t', logs: [log('rescue_vote', { id: 2 })] } } },
      { execution_outcome: { id: 'R3', block_height: 11, block_timestamp: '1700000001000000000', outcome: { executor_id: 'v.t', logs: [`EVENT_JSON:${JSON.stringify({ standard: 'nep141', event: 'ft_transfer', data: [{}] })}`] } } },
    ],
  };
  const out = parseEvents(tx, 'v.t');
  assert.equal(out.length, 1);
  assert.equal(out[0].event, 'rescue_vote');
  assert.equal(out[0].key, 'R1:0:0');
  assert.equal(out[0].ts_ms, 1700000000000);
  assert.match(out[0].explorer, /\/txns\/H$/);
});
