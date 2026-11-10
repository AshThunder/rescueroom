// Point the vault's Sepolia safe address at an address the guardian DAO itself controls
// (MPC-derived from the DAO account), via a Sputnik FunctionCall proposal -> dao_update_config.
import { ethers } from 'ethers';
import bs58 from './lib/bs58.js';
import { call, view, loadState, saveState, TGAS } from './lib/near.js';

const st = loadState();
const path = 'rescueroom-safe-1';
const pk = await view('v1.signer-prod.testnet', 'derived_public_key', { path, predecessor: st.dao, domain_id: 0 });
const safe = ethers.computeAddress('0x04' + Buffer.from(bs58.decode(pk.split(':')[1])).toString('hex'));
const cfg = await view(st.vault, 'get_config');
if (cfg.safe_evm.toLowerCase() === safe.toLowerCase()) {
  console.log('already set', safe);
  process.exit(0);
}
cfg.safe_evm = safe;
const kind = { FunctionCall: { receiver_id: st.vault, actions: [{ method_name: 'dao_update_config', args: Buffer.from(JSON.stringify({ config: cfg })).toString('base64'), deposit: '0', gas: (50n * TGAS).toString() }] } };
const bond = BigInt((await view(st.dao, 'get_policy')).proposal_bond);
const p = await call(st.g1, st.dao, 'add_proposal', { proposal: { description: `Set Sepolia safe address to DAO-controlled ${safe} (MPC path ${path})`, kind } }, { deposit: bond, gas: 100n * TGAS });
console.log('proposal', p.value, p.hash);
await call(st.g1, st.dao, 'act_proposal', { id: p.value, action: 'VoteApprove', proposal: kind }, { gas: 200n * TGAS });
const a = await call(st.g3, st.dao, 'act_proposal', { id: p.value, action: 'VoteApprove', proposal: kind }, { gas: 200n * TGAS });
console.log('approved', a.hash);
await new Promise((r) => setTimeout(r, 3000));
const now = (await view(st.vault, 'get_config')).safe_evm;
console.log('vault safe_evm now', now, now.toLowerCase() === safe.toLowerCase() ? 'OK' : 'NOT UPDATED');
st.safe_evm = safe;
st.safe_evm_path = path;
saveState(st);
