// NEP-297 event indexer for Rescue Room vaults, built on the free FastNEAR transactions API (testnet).
// For each watched account: list its transactions, fetch receipts for new ones, keep every
// EVENT_JSON log with standard "rescueroom" emitted by that account. Cached to server/data/.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.RR_DATA_DIR || (process.env.VERCEL ? '/tmp/rescueroom' : path.resolve(HERE, '../data'));
const API = process.env.FASTNEAR_TX_API || 'https://tx.test.fastnear.com';
const EXPLORER = process.env.NEAR_EXPLORER || 'https://testnet.nearblocks.io';

async function post(route, body) {
  const r = await fetch(`${API}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${route} ${r.status}`);
  return r.json();
}

export function parseEvents(tx, account) {
  const out = [];
  const hash = tx.transaction.hash;
  const signer = tx.transaction.signer_id;
  for (const { execution_outcome: eo, receipt } of tx.receipts || []) {
    const o = eo.outcome;
    if (o.executor_id !== account) continue;
    o.logs.forEach((line, i) => {
      if (!line.startsWith('EVENT_JSON:')) return;
      let ev;
      try {
        ev = JSON.parse(line.slice(11));
      } catch {
        return;
      }
      if (ev.standard !== 'rescueroom') return;
      for (const [j, data] of (ev.data || [{}]).entries()) {
        out.push({
          key: `${eo.id}:${i}:${j}`,
          account,
          event: ev.event,
          version: ev.version,
          data,
          tx_hash: hash,
          receipt_id: eo.id,
          signer,
          predecessor: receipt?.predecessor_id,
          block_height: eo.block_height,
          ts_ms: Math.floor(Number(eo.block_timestamp) / 1e6),
          explorer: `${EXPLORER}/txns/${hash}`,
          receipt_explorer: `${EXPLORER}/txns/${hash}#execution`,
        });
      }
    });
  }
  return out;
}

export class Indexer extends EventEmitter {
  constructor(accounts, { intervalMs = Number(process.env.INDEXER_INTERVAL_MS || 6000) } = {}) {
    super();
    this.accounts = [...new Set(accounts.filter(Boolean))];
    this.intervalMs = intervalMs;
    this.state = {};
    this.lastError = null;
    this.lastSync = null;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    for (const a of this.accounts) {
      const f = this.file(a);
      const st = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { seen: [], events: [] };
      const keys = new Set();
      st.events = st.events.filter((e) => !keys.has(e.key) && keys.add(e.key));
      st.seen = [...new Set(st.seen)];
      this.state[a] = st;
    }
  }

  /** Start watching another account (hosted defender: vaults discovered from the factory). */
  add(a) {
    if (!a || this.state[a]) return false;
    const f = this.file(a);
    this.state[a] = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { seen: [], events: [] };
    this.accounts.push(a);
    return true;
  }

  file(a) {
    return path.join(DATA_DIR, `events-${a}.json`);
  }

  async listTxs(account) {
    // Newest first; page backwards until we reach hashes we already have.
    const known = new Set(this.state[account].seen);
    const all = [];
    const taken = new Set();
    let max;
    for (let page = 0; page < 20; page++) {
      const d = await post('/v0/account', { account_id: account, ...(max ? { max_block_height: max } : {}) });
      const txs = d.account_txs || [];
      const fresh = [];
      for (const t of txs) {
        if (known.has(t.transaction_hash) || taken.has(t.transaction_hash)) continue;
        taken.add(t.transaction_hash);
        fresh.push(t);
      }
      all.push(...fresh);
      if (txs.length < 50 || fresh.length < txs.length) break;
      max = Math.min(...txs.map((t) => t.tx_block_height)) - 1;
    }
    return all;
  }

  async syncAccount(account) {
    const s = this.state[account];
    const txs = await this.listTxs(account);
    if (!txs.length) return [];
    const added = [];
    for (let i = 0; i < txs.length; i += 20) {
      const batch = txs.slice(i, i + 20).map((t) => t.transaction_hash);
      const d = await post('/v0/transactions', { tx_hashes: batch });
      for (const tx of d.transactions || []) {
        if (!tx) continue;
        added.push(...parseEvents(tx, account));
      }
      // Only mark hashes whose receipts are all final in this response.
      // Mark a hash done only once it is old enough for every receipt (MPC callbacks included)
      // to have landed; until then it is re-read each pass and dedup by receipt key keeps it clean.
      const got = new Set((d.transactions || []).filter(Boolean).map((t) => t.transaction.hash));
      const settled = new Set(txs.filter((t) => Date.now() - Number(t.tx_block_timestamp) / 1e6 > 180_000).map((t) => t.transaction_hash));
      s.seen.push(...batch.filter((h) => got.has(h) && settled.has(h)));
    }
    const have = new Set(s.events.map((e) => e.key));
    const fresh = [];
    for (const e of added) {
      if (have.has(e.key)) continue;
      have.add(e.key);
      fresh.push(e);
    }
    s.events.push(...fresh);
    s.events.sort((a, b) => b.block_height - a.block_height || (a.key < b.key ? 1 : -1));
    fs.writeFileSync(this.file(account), JSON.stringify(s));
    return fresh.sort((a, b) => a.block_height - b.block_height);
  }

  async sync() {
    const fresh = [];
    for (const a of this.accounts) {
      try {
        fresh.push(...(await this.syncAccount(a)));
      } catch (e) {
        this.lastError = `${a}: ${e.message}`;
      }
    }
    this.lastSync = Date.now();
    for (const e of fresh) this.emit('event', e);
    return fresh;
  }

  start() {
    const loop = async () => {
      await this.sync();
      this.timer = setTimeout(loop, this.intervalMs);
    };
    loop();
    return this;
  }

  stop() {
    clearTimeout(this.timer);
  }

  events(account, { limit = 200, event, requestId } = {}) {
    let list = account ? this.state[account]?.events || [] : Object.values(this.state).flatMap((s) => s.events).sort((a, b) => b.block_height - a.block_height);
    if (event) list = list.filter((e) => e.event === event);
    if (requestId !== undefined) list = list.filter((e) => String(e.data?.id) === String(requestId) || String(e.data?.request_id) === String(requestId));
    return list.slice(0, limit);
  }
}
