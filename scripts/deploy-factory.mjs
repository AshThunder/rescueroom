// Deploy the vault code as a NEAR global contract (by hash) and the factory that creates vaults from it.
// Usage: node scripts/deploy-factory.mjs [--code-only] [--lock]
//   --lock deletes the factory's full-access key afterwards (the guardian DAO stays its only owner).
// Keys: ~/.rescueroom/keys (chmod 600). Public summary: deploy/factory.json.
import fs from 'node:fs';
import crypto from 'node:crypto';
import bs58 from './lib/bs58.js';
import { account, call, exists, hasKey, newKey, view, near, fmtNear, loadState, saveState, loadKeyPair, provider, TGAS } from './lib/near.js';

const st = loadState();
const MAIN = st.main;
const FACTORY = st.factory || `factory.${MAIN}`;
const main = account(MAIN);
const vaultWasm = fs.readFileSync('contracts/vault/target/near/rescueroom_vault.wasm');
const factoryWasm = fs.readFileSync('contracts/factory/target/near/rescueroom_factory.wasm');
const codeHash = bs58.encode(crypto.createHash('sha256').update(vaultWasm).digest());

async function globalExists(hash) {
  try {
    await provider.query({ request_type: 'view_global_contract_code', code_hash: hash, finality: 'final' });
    return true;
  } catch {
    return false;
  }
}

async function sweepFunders() {
  for (const f of st.funders || []) {
    if (!hasKey(f) || !(await exists(f))) continue;
    const bal = await account(f).getBalance();
    if (bal > near(1)) {
      await account(f).transfer({ receiverId: MAIN, amount: bal - near(0.05) });
      console.log(`swept ${fmtNear(bal - near(0.05))} NEAR from ${f}`);
    }
  }
}

await sweepFunders();
if (await globalExists(codeHash)) console.log(`global vault code ${codeHash} already deployed`);
else {
  console.log(`deploying global vault code ${codeHash} (${vaultWasm.length} bytes, burns ~${(vaultWasm.length / 1e4).toFixed(1)} NEAR)`);
  const r = await main.deployGlobalContract(vaultWasm, 'codeHash');
  console.log(`global contract tx ${r.transaction.hash}`);
}
if (process.argv.includes('--code-only')) process.exit(0);

if (!(await exists(FACTORY))) {
  const pk = hasKey(FACTORY) ? loadKeyPair(FACTORY).getPublicKey().toString() : newKey(FACTORY);
  await main.createSubAccount({ accountOrPrefix: FACTORY.split('.')[0], publicKey: pk, nearToTransfer: near(3.5) });
  console.log(`created ${FACTORY}`);
}
const fac = account(FACTORY);
const deployed = await provider.viewAccount({ accountId: FACTORY });
const facHash = bs58.encode(crypto.createHash('sha256').update(factoryWasm).digest());
if (deployed.code_hash !== facHash) {
  const r = await fac.deployContract(factoryWasm);
  console.log(`factory code deployed tx ${r.transaction.hash}`);
}
let initialized = true;
try {
  await view(FACTORY, 'version');
  await view(FACTORY, 'get_costs');
} catch {
  initialized = false;
}
const cfg = await view(st.vault, 'get_config');
const defaults = {
  watcher: cfg.watcher, watcher_pk: cfg.watcher_pk, relayer: cfg.relayer,
  mpc_contract: cfg.evm.mpc_contract, evm_path: cfg.evm.path, chain_id: cfg.evm.chain_id,
  max_fee_per_gas: cfg.evm.max_fee_per_gas, max_priority_fee_per_gas: cfg.evm.max_priority_fee_per_gas, gas_limit: cfg.evm.gas_limit,
  demo_guardians: [st.g1, st.g2, st.g3],
};
const costs = { vault_storage: near(Number(process.env.VAULT_STORAGE_NEAR || 0.05)).toString(), registry_fee: near(0.01).toString(), demo_deposit: near(Number(process.env.DEMO_DEPOSIT_NEAR || 1.5)).toString() };
if (!initialized) {
  const r = await call(fac, FACTORY, 'new', { owner: st.dao, vault_code: codeHash, defaults, costs }, { gas: 50n * TGAS });
  console.log(`factory initialized tx ${r.hash}`);
} else if ((await view(FACTORY, 'get_vault_code')) !== codeHash) {
  console.log(`NOTE factory points at ${await view(FACTORY, 'get_vault_code')}; switching needs a DAO proposal set_vault_code(${codeHash})`);
}
st.factory = FACTORY;
saveState(st);
if (process.argv.includes('--lock')) {
  const pk = loadKeyPair(FACTORY).getPublicKey().toString();
  const r = await fac.deleteKey(pk);
  console.log(`deleted factory full-access key tx ${r.transaction.hash}`);
}
const keys = (await provider.viewAccessKeyList({ accountId: FACTORY })).keys.length;
const out = { network: 'testnet', factory: FACTORY, owner: st.dao, vault_code_hash: codeHash, vault_version: '1.4.0', factory_version: await view(FACTORY, 'version'), costs: await view(FACTORY, 'get_costs'), demo_guardians: defaults.demo_guardians, access_keys: keys };
fs.writeFileSync('deploy/factory.json', JSON.stringify(out, null, 2) + '\n');
console.log(out);
