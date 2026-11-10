// Idempotent testnet setup: funding, role accounts, Sputnik DAO, vault deploy + init.
// Usage: node scripts/deploy.mjs <main-account.testnet>
// Keys: ~/.rescueroom/keys (chmod 600). Public summary: deploy/testnet.json (no secrets).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { actions as actionCreators } from 'near-api-js';
import { account, exists, hasKey, newKey, view, near, fmtNear, loadState, saveState, loadKeyPair } from './lib/near.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = process.argv[2] || loadState().main;
if (!MAIN) throw new Error('usage: node scripts/deploy.mjs <main.testnet>');
const st = { ...loadState(), main: MAIN };
const main = account(MAIN);
const sub = (p) => `${p}.${MAIN}`;

const ROLES = {
  owner: 3, watcher: 1, relayer: 1, safe: 0.2, g1: 0.6, g2: 0.6, g3: 0.6, attacker: 1, vendor: 0.2,
};

async function sweepFunders() {
  for (const f of st.funders || []) {
    if (!hasKey(f) || !(await exists(f))) continue;
    const a = account(f);
    const bal = await a.getBalance();
    const keep = near(0.05);
    if (bal > near(1)) {
      await a.transfer({ receiverId: MAIN, amount: bal - keep });
      console.log(`swept ${fmtNear(bal - keep)} NEAR from ${f}`);
    }
  }
}

async function ensureSub(prefix, amount) {
  const id = sub(prefix);
  if (await exists(id)) return id;
  const pk = hasKey(id) ? loadKeyPair(id).getPublicKey().toString() : newKey(id);
  await main.createSubAccount({ accountOrPrefix: prefix, publicKey: pk, nearToTransfer: near(amount) });
  console.log(`created ${id} with ${amount} NEAR`);
  return id;
}

async function ensureDao() {
  const name = (MAIN.split('.')[0] + '-guardians').slice(0, 40);
  const factory = 'sputnik-v2.testnet';
  const daoId = `${name}.${factory}`;
  if (await exists(daoId)) return daoId;
  const args = {
    config: { name, purpose: 'Rescue Room guardian council (testnet demo)', metadata: '' },
    policy: [sub('g1'), sub('g2'), sub('g3')],
  };
  await main.callFunction({
    contractId: factory,
    methodName: 'create',
    args: { name, args: Buffer.from(JSON.stringify(args)).toString('base64') },
    deposit: near(6),
    gas: 300n * 10n ** 12n,
  });
  console.log(`created DAO ${daoId}`);
  return daoId;
}

function ensureEvidenceKey() {
  const id = 'watcher-evidence-signing';
  if (!hasKey(id)) newKey(id);
  return loadKeyPair(id).getPublicKey().toString();
}

async function main_() {
  await sweepFunders();
  console.log('main balance', fmtNear(await main.getBalance()));
  for (const [p, amt] of Object.entries(ROLES)) st[p] = await ensureSub(p, amt);
  st.dao = await ensureDao();
  const prefix = process.env.VAULT_PREFIX || 'vault';
  const vaultId = sub(prefix);
  st.vault = vaultId;
  const fresh = !(await exists(vaultId));
  if (fresh) await ensureSub(prefix, 8);
  const vault = account(vaultId);
  const wasm = fs.readFileSync(path.join(ROOT, 'contracts/vault/target/near/rescueroom_vault.wasm'));
  const state = await vault.getState();
  const deployed = state.codeHash && state.codeHash !== '11111111111111111111111111111111';
  if (!deployed || process.env.REDEPLOY) {
    const watcherPk = ensureEvidenceKey();
    const cfg = {
      owner: st.owner,
      guardian_dao: st.dao,
      guardian_role: 'council',
      quorum_pct: 50,
      min_distinct: 2,
      watcher: st.watcher,
      watcher_pk: watcherPk,
      relayer: st.relayer,
      safe_near: st.safe,
      safe_evm: st.safe_evm || '0x000000000000000000000000000000000000dEaD',
      near_allowance: { limit: near(1).toString(), window_secs: 86400 },
      eth_allowance: { limit: (2n * 10n ** 15n).toString(), window_secs: 86400 },
      hold_tiers: [
        { min_score: 0, hold_secs: 0 },
        { min_score: 30, hold_secs: 3600 },
        { min_score: 60, hold_secs: 10800 },
        { min_score: 80, hold_secs: 21600 },
      ],
      hold_floor_secs: 0,
      unscored_hold_secs: 21600,
      evm: {
        mpc_contract: 'v1.signer-prod.testnet',
        path: 'rescueroom-eth-1',
        chain_id: 11155111,
        max_fee_per_gas: (30n * 10n ** 9n).toString(),
        max_priority_fee_per_gas: (2n * 10n ** 9n).toString(),
        gas_limit: 21000,
      },
      cover: { base_premium_bps: 200, per_incident_cap: near(1).toString(), term_secs: 30 * 86400 },
      demo_time_divisor: 60,
    };
    const actions = [actionCreators.deployContract(wasm)];
    if (!deployed) actions.push(actionCreators.functionCall('new', { config: cfg, guardians: [] }, 100n * 10n ** 12n, 0n));
    await vault.signAndSendTransaction({ receiverId: vaultId, actions });
    console.log(`deployed vault to ${vaultId}${deployed ? ' (code only)' : ' + init'}`);
  }
  // Sync guardians from the DAO policy.
  await main.callFunction({ contractId: vaultId, methodName: 'sync_guardians', args: {}, gas: 60n * 10n ** 12n });
  // Derive the vault's Sepolia address from the MPC signer.
  const cfg = await view(vaultId, 'get_config');
  const pk = await view('v1.signer-prod.testnet', 'derived_public_key', { path: cfg.evm.path, predecessor: vaultId, domain_id: 0 });
  const { ethers } = await import('ethers');
  const bs58 = (await import('./lib/bs58.js')).default;
  const raw = bs58.decode(pk.split(':')[1]); // 64-byte uncompressed (x||y)
  st.vault_evm = ethers.computeAddress('0x04' + Buffer.from(raw).toString('hex'));
  st.vault_evm_pubkey = pk;
  saveState(st);
  const pub = {
    network: 'testnet',
    vault: st.vault, owner: st.owner, dao: st.dao, watcher: st.watcher, relayer: st.relayer, safe_near: st.safe,
    guardians: [st.g1, st.g2, st.g3], attacker: st.attacker, vendor: st.vendor,
    mpc_signer: 'v1.signer-prod.testnet', evm_path: cfg.evm.path, vault_sepolia_address: st.vault_evm,
    safe_evm: cfg.safe_evm,
    ...(st.safe_evm_path ? { safe_evm_note: `MPC-derived from the guardian DAO account, path ${st.safe_evm_path}` } : {}),
    ...(st.legacy_vaults ? { legacy_vaults: st.legacy_vaults } : {}),
  };
  fs.mkdirSync(path.join(ROOT, 'deploy'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'deploy/testnet.json'), JSON.stringify(pub, null, 2) + '\n');
  console.log(JSON.stringify(pub, null, 2));
  console.log('status', JSON.stringify(await view(vaultId, 'get_status')));
}

main_().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
