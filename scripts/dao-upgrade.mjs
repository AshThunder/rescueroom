// Upgrade the vault's code through the guardian DAO (Sputnik UpgradeRemote).
// 1) store the wasm as a DAO blob, 2) propose UpgradeRemote -> vault.upgrade(), 3) two guardians approve,
// 4) verify version(), 5) remove the blob to recover its storage deposit.
// Usage: node scripts/dao-upgrade.mjs <wasm> [expected-version]
import fs from 'node:fs';
import crypto from 'node:crypto';
import bs58 from './lib/bs58.js';
import { actions } from 'near-api-js';
import { account, call, view, loadState, near, TGAS, fmtNear } from './lib/near.js';

const st = loadState();
const V = process.env.VAULT || st.vault;
const wasm = fs.readFileSync(process.argv[2]);
const expect = process.argv[3];
const g1 = account(st.g1);
const before = await view(V, 'version');
console.log(`vault ${V} at version ${before}; uploading ${wasm.length} bytes to ${st.dao}`);

// Sputnik's UpgradeRemote (blob) path keeps only 15 Tgas for itself after forwarding the code, which is
// not enough for a ~345 KB wasm on the factory version testnet DAOs run. So by default the code goes
// inline as a FunctionCall proposal to vault.upgrade(); the DAO pays the proposal's storage.
// The vault gets 120 Tgas (deploy ~25 + migrate 30); the DAO needs the rest to re-parse ~460 KB of args.
// UPGRADE_MODE=blob uses store_blob + UpgradeRemote instead (works for smaller wasm).
const mode = process.env.UPGRADE_MODE || 'inline';
const main = account(st.main);
const hash = bs58.encode(crypto.createHash('sha256').update(wasm).digest());
let sb = { transaction: { hash: null } };
let kind;
if (mode === 'blob') {
  const deposit = BigInt(wasm.length + 200) * 10n ** 19n + near(0.1);
  if (!(await view(st.dao, 'has_blob', { hash }))) {
    sb = await main.signAndSendTransaction({ receiverId: st.dao, actions: [actions.functionCall('store_blob', wasm, 300n * TGAS, deposit, (x) => x)] });
    console.log(`stored blob ${hash} tx ${sb.transaction.hash}`);
  }
  kind = { UpgradeRemote: { receiver_id: V, method_name: 'upgrade', hash } };
} else {
  if (await view(st.dao, 'has_blob', { hash })) {
    const rb0 = await call(main, st.dao, 'remove_blob', { hash }, { gas: 50n * TGAS });
    console.log(`removed stale blob, refunded, tx ${rb0.hash}`);
  }
  // Storage for the proposal (~1.34x the wasm as base64) is paid from the DAO balance.
  const need = BigInt(Math.ceil(wasm.length * 1.4)) * 10n ** 19n + near(0.5);
  const daoBal = BigInt((await main.provider.viewAccount({ accountId: st.dao })).amount);
  const daoAcc = await main.provider.viewAccount({ accountId: st.dao });
  const free = daoBal - BigInt(daoAcc.storage_usage) * 10n ** 19n;
  if (free < need) {
    await main.transfer({ receiverId: st.dao, amount: need - free + near(0.5) });
    console.log(`funded DAO storage with ${fmtNear(need - free + near(0.5))} NEAR`);
  }
  kind = { FunctionCall: { receiver_id: V, actions: [{ method_name: 'upgrade', args: wasm.toString('base64'), deposit: '0', gas: (120n * TGAS).toString() }] } };
}
console.log(`code sha256 (base58) ${hash}, mode ${mode}`);

const bond = BigInt((await view(st.dao, 'get_policy')).proposal_bond);
const p = await call(g1, st.dao, 'add_proposal', { proposal: { description: `Upgrade Rescue Room vault to ${expect || 'new code'} (code sha256 ${hash})`, kind } }, { deposit: bond, gas: 300n * TGAS });
console.log(`proposal ${p.value} tx ${p.hash}`);
await call(g1, st.dao, 'act_proposal', { id: p.value, action: 'VoteApprove', proposal: kind }, { gas: 300n * TGAS });
const a = await call(st.g2, st.dao, 'act_proposal', { id: p.value, action: 'VoteApprove', proposal: kind }, { gas: 300n * TGAS });
console.log(`approved + executed tx ${a.hash}`);
await new Promise((r) => setTimeout(r, 3000));
const after = await view(V, 'version');
console.log(`vault version now ${after}${expect ? (after === expect ? ' (OK)' : ` (EXPECTED ${expect})`) : ''}`);
let rb = { hash: null };
if (mode === 'blob') {
  rb = await call(main, st.dao, 'remove_blob', { hash }, { gas: 50n * TGAS });
  console.log(`removed blob, storage refunded, tx ${rb.hash}`);
}
const out = { at: new Date().toISOString(), vault: V, from: before, to: after, mode, code_hash: hash, proposal: p.value, txs: { store_blob: sb.transaction.hash, add_proposal: p.hash, approve_execute: a.hash, remove_blob: rb.hash } };
fs.writeFileSync(new URL('../deploy/dao-upgrade.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
if (expect && after !== expect) process.exit(1);
