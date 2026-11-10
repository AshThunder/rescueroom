// Delete the vault account's own full-access key(s). After this, the code can only change
// through a guardian DAO UpgradeRemote proposal (see dao-upgrade.mjs).
// Usage: node scripts/lock-vault.mjs [vault-account]
import fs from 'node:fs';
import { actions, PublicKey } from 'near-api-js';
import { account, loadState, provider } from './lib/near.js';

const st = loadState();
const V = process.argv[2] || st.vault;
const list = await provider.viewAccessKeyList({ accountId: V });
const full = list.keys.filter((k) => k.access_key.permission === 'FullAccess');
const fc = list.keys.length - full.length;
if (!full.length) {
  console.log(`${V}: already locked (no full-access keys; ${fc} function-call keys)`);
  process.exit(0);
}
const code = (await provider.viewAccount({ accountId: V })).code_hash;
if (!code || code === '11111111111111111111111111111111') throw new Error('refusing to lock an account with no contract');
const r = await account(V).signAndSendTransaction({ receiverId: V, actions: full.map((k) => actions.deleteKey(PublicKey.fromString(k.public_key))) });
const after = await provider.viewAccessKeyList({ accountId: V });
console.log(`${V}: deleted ${full.length} full-access key(s) in tx ${r.transaction.hash}`);
console.log(`remaining keys: ${after.keys.map((k) => (k.access_key.permission === 'FullAccess' ? 'FULL' : 'function-call')).join(', ') || 'none'}`);
const f = new URL('../deploy/locks.json', import.meta.url);
const prev = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
prev[V] = { at: new Date().toISOString(), deleted_full_access_keys: full.length, tx: r.transaction.hash, remaining_keys: after.keys.length };
fs.writeFileSync(f, JSON.stringify(prev, null, 2) + '\n');
