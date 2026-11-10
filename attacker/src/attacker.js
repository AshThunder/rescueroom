// Scripted attacker: holds a stolen agent function-call key and tries to drain the vault in chunks.
// Testnet only. It can only call request_withdraw (that is all the key allows).
// Usage: node attacker/src/attacker.js [chunks NEAR, e.g. 0.5,0.5,2]
import { Account, KeyPairSigner } from 'near-api-js';
import { call, loadState, loadKeyPair, provider, near, view, fmtNear, TGAS } from '../../scripts/lib/near.js';

const st = loadState();
const V = st.vault;
const agent = new Account(V, provider, new KeyPairSigner(loadKeyPair(`agent-key-${V}`)));
const plan = (process.argv[2] || '').split(',').filter(Boolean).map(Number);

const s = await view(V, 'get_status');
const hot = BigInt(s.near_hot_remaining);
const chunks = plan.length ? plan.map(near) : [...(hot > 0n ? [hot] : []), near(0.5), near(2)];
console.log(`attacker: vault ${V}, hot allowance left ${fmtNear(hot)} NEAR, plan ${chunks.map(fmtNear).join(' + ')}`);
for (const c of chunks) {
  try {
    const r = await call(agent, V, 'request_withdraw', { asset: 'Near', to: st.attacker, amount: c.toString(), memo: 'ops payout' }, { gas: 100n * TGAS });
    const req = await view(V, 'get_request', { id: r.value });
    console.log(`  #${r.value} ${fmtNear(c)} NEAR -> ${req.hot ? 'paid instantly (hot allowance; cover pool territory)' : `HELD until ${new Date(Number(req.release_ms)).toISOString()}`}  tx ${r.hash}`);
  } catch (e) {
    console.log(`  ${fmtNear(c)} NEAR -> rejected: ${String(e.message).slice(0, 120)}`);
  }
}
