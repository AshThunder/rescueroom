// Live Sepolia run on a vault that holds real Sepolia ETH (default: the phase-1 vault).
// 1. Upgrade it to the current code (direct deploy while it still has its own key, else skip).
// 2. One DAO proposal: lower EVM gas fees and rewind the nonce to the chain nonce (supersedes stale txs).
// 3. Hot-allowance send (instant, MPC-signed) and a held request that guardians rescue to the safe address.
// 4. Relay both in nonce order, wait for mining, then DAO-unfreeze. Writes deploy/sepolia-live.json.
// Usage: VAULT=vault.rescueroom-j60ox4.testnet node --env-file-if-exists=.env scripts/sepolia-live.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { actions as actionCreators } from 'near-api-js';
import { account, call, view, loadState, hasKey, TGAS } from './lib/near.js';
import { finalize, deriveVaultEvm, SEPOLIA_RPC } from './lib/evm.js';
import { tick as watcherTick } from '../watcher/src/watcher.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const st = loadState();
const V = process.env.VAULT || 'vault.rescueroom-j60ox4.testnet';
process.env.VAULT = V;
const HOT_TO = process.env.HOT_TO || st.vault_evm; // tops up the demo vault's Sepolia address
const HOT_WEI = BigInt(process.env.HOT_WEI || 10n ** 15n); // 0.001 ETH (allowance 0.002)
const HELD_WEI = BigInt(process.env.HELD_WEI || 10n ** 16n); // 0.01 ETH, above the allowance -> held
const MAX_FEE = BigInt(process.env.MAX_FEE_WEI || 2n * 10n ** 9n); // 2 gwei cap
const PRIO_FEE = BigInt(process.env.PRIO_FEE_WEI || 2n * 10n ** 8n); // 0.2 gwei tip
// Sepolia charges ~207k gas for a value transfer that creates a new account (12k otherwise).
const GAS_LIMIT = Number(process.env.GAS_LIMIT || 220000);
const eth = new ethers.JsonRpcProvider(SEPOLIA_RPC);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nb = (h) => `https://testnet.nearblocks.io/txns/${h}`;
const out = { vault: V, steps: [] };
const step = (name, d = {}) => {
  out.steps.push({ at: new Date().toISOString(), name, ...d, ...(d.hash ? { explorer: nb(d.hash) } : {}) });
  console.log(`- ${name}${d.hash ? `  ${nb(d.hash)}` : ''}${d.note ? `  (${d.note})` : ''}`);
};
async function waitFor(id, pred, label, ms = 240_000) {
  const t0 = Date.now();
  for (;;) {
    const r = await view(V, 'get_request', { id });
    if (pred(r)) return r;
    if (Date.now() - t0 > ms) throw new Error(`timeout: #${id} ${label} (status ${r.status})`);
    await sleep(3000);
  }
}
async function daoProposal(description, actions) {
  const policy = await view(st.dao, 'get_policy');
  const kind = { FunctionCall: { receiver_id: V, actions } };
  const ap = await call(st.g1, st.dao, 'add_proposal', { proposal: { description, kind } }, { deposit: BigInt(policy.proposal_bond), gas: 100n * TGAS });
  await call(st.g1, st.dao, 'act_proposal', { id: ap.value, action: 'VoteApprove', proposal: kind }, { gas: 250n * TGAS });
  const a2 = await call(st.g2, st.dao, 'act_proposal', { id: ap.value, action: 'VoteApprove', proposal: kind }, { gas: 250n * TGAS });
  return { pid: ap.value, add: ap.hash, approve: a2.hash };
}
const fc = (method_name, args, tgas = 50n) => ({ method_name, args: Buffer.from(JSON.stringify(args)).toString('base64'), deposit: '0', gas: (tgas * TGAS).toString() });

const from = await deriveVaultEvm(view, V);
out.vault_evm = from;
console.log(`vault ${V}, Sepolia ${from}, balance ${ethers.formatEther(await eth.getBalance(from))} ETH`);

// 1. Upgrade
let version = null;
try { version = await view(V, 'version'); } catch {}
const wasmPath = path.join(ROOT, 'contracts/vault/target/near/rescueroom_vault.wasm');
if (version !== '1.2.0') {
  if (!hasKey(V)) throw new Error('vault has no key here; upgrade through scripts/dao-upgrade.mjs');
  const res = await account(V).signAndSendTransaction({ receiverId: V, actions: [actionCreators.deployContract(fs.readFileSync(wasmPath)), actionCreators.functionCall('migrate', {}, 50n * TGAS, 0n)] });
  step(`Upgraded ${version || 'phase-1'} -> ${await view(V, 'version')}`, { hash: res.transaction.hash });
}

// 2. Gas + nonce resync through the DAO
const chainNonce = await eth.getTransactionCount(from);
const cfg0 = await view(V, 'get_config');
const cfg = cfg0;
const status = await view(V, 'get_status');
const actions = [];
if (status.frozen) actions.push(fc('dao_unfreeze', {}, 30n));
if (BigInt(cfg.evm.max_fee_per_gas) !== MAX_FEE || BigInt(cfg.evm.max_priority_fee_per_gas) !== PRIO_FEE || cfg.evm.gas_limit !== GAS_LIMIT) {
  actions.push(fc('dao_update_config', { config: { ...cfg, evm: { ...cfg.evm, gas_limit: GAS_LIMIT, max_fee_per_gas: MAX_FEE.toString(), max_priority_fee_per_gas: PRIO_FEE.toString() } } }));
}
if (status.evm_nonce !== chainNonce) actions.push(fc('dao_resync_evm_nonce', { nonce: chainNonce }));
if (actions.length) {
  const p = await daoProposal(`Lower Sepolia gas fees and resync nonce to ${chainNonce}`, actions);
  await sleep(3000);
  const s2 = await view(V, 'get_status');
  step(`DAO proposal ${p.pid}: gas limit ${GAS_LIMIT}, cap ${ethers.formatUnits(MAX_FEE, 'gwei')} gwei, tip ${ethers.formatUnits(PRIO_FEE, 'gwei')} gwei, nonce ${status.evm_nonce} -> ${s2.evm_nonce}`, { hash: p.approve });
}

// 3a. Hot-allowance send
const hot = await call(st.owner, V, 'request_withdraw', { asset: 'SepoliaEth', to: HOT_TO, amount: HOT_WEI.toString(), memo: 'Sepolia hot-allowance send' }, { gas: 300n * TGAS });
step(`Hot send #${hot.value}: ${ethers.formatEther(HOT_WEI)} ETH to ${HOT_TO} -> MPC sign`, { hash: hot.hash, id: hot.value });
const hr = await waitFor(hot.value, (x) => x.signature || x.status === 'Failed', 'signature');
if (!hr.signature) throw new Error('hot send signing failed');

// 3b. Held request -> rescue
const held = await call(st.owner, V, 'request_withdraw', { asset: 'SepoliaEth', to: '0x' + '22'.repeat(20), amount: HELD_WEI.toString(), memo: 'large ETH transfer (suspicious)' }, { gas: 300n * TGAS });
step(`Held request #${held.value}: ${ethers.formatEther(HELD_WEI)} ETH to an unknown address`, { hash: held.hash, id: held.value });
for (let i = 0; i < 20; i++) {
  await watcherTick(V);
  if ((await view(V, 'get_request', { id: held.value })).score) break;
  await sleep(2000);
}
const sc = await view(V, 'get_request', { id: held.value });
step(`Watcher scored #${held.value}`, { note: `score ${sc.score?.score}; ${sc.score ? 'explanation by ' + (sc.score.signals ? 'rules' : '') : 'no score'}` });
await call(st.g2, V, 'vote_rescue', { id: held.value }, { gas: 100n * TGAS });
const vr = await call(st.g3, V, 'vote_rescue', { id: held.value }, { gas: 300n * TGAS });
step(`Guardians g2 + g3 rescued #${held.value} -> MPC signs transfer to safe ${cfg.safe_evm}`, { hash: vr.hash });
const rr = await waitFor(held.value, (x) => !!x.signature, 'rescue signature');
const f = finalize(rr.evm_tx, rr.signature);
if (!f.payloadMatches || f.from.toLowerCase() !== from.toLowerCase() || rr.evm_tx.to.toLowerCase() !== cfg.safe_evm.toLowerCase()) throw new Error('rescue tx check failed');

// 4. Relay
const { relayOnce } = await import('./relayer.mjs');
let sent = [];
for (let i = 0; i < 3 && sent.length < 2; i++) sent = sent.concat(await relayOnce());
out.sepolia = sent;
for (const s of sent) step(`Sepolia tx #${s.id} nonce ${s.nonce}: ${s.value} ETH to ${s.to}, status ${s.status}, fee ${s.fee_eth} ETH`, { sepolia: s.hash, sepolia_explorer: s.explorer });

const p = await daoProposal('Unfreeze vault after the Sepolia rescue drill', [fc('dao_unfreeze', {}, 30n)]);
step(`DAO proposal ${p.pid}: unfrozen=${!(await view(V, 'get_status')).frozen}`, { hash: p.approve });
out.balance_after = ethers.formatEther(await eth.getBalance(from));
out.safe_balance_after = ethers.formatEther(await eth.getBalance(cfg.safe_evm));
fs.writeFileSync(path.join(ROOT, 'deploy/sepolia-live.json'), JSON.stringify(out, null, 2));
console.log(`done. vault ${out.balance_after} ETH, safe ${out.safe_balance_after} ETH`);
