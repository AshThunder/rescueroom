// Relayer: broadcasts MPC-signed Sepolia transactions and records the tx hash on the vault.
// It cannot change destination or amount: those are fixed inside the signed payload.
// Usage: [VAULT=<vault account>] node scripts/relayer.mjs [--once]
// The expected sender is derived from the MPC signer for VAULT, so any Rescue Room vault can be relayed.
import { ethers } from 'ethers';
import { account, view, loadState } from './lib/near.js';
import { finalize, deriveVaultEvm, SEPOLIA_RPC } from './lib/evm.js';

const st = loadState();
const DEFAULT_VAULT = process.env.VAULT || st.vault;
const eth = new ethers.JsonRpcProvider(SEPOLIA_RPC);
const expectedFor = new Map();
const explorer = (h) => `https://sepolia.etherscan.io/tx/${h}`;

export async function relayOnce(VAULT = DEFAULT_VAULT) {
  let expected = expectedFor.get(VAULT);
  if (!expected) {
    expected = (VAULT === DEFAULT_VAULT && process.env.VAULT_EVM) || (VAULT === st.vault ? st.vault_evm : await deriveVaultEvm(view, VAULT));
    expectedFor.set(VAULT, expected);
  }
  const reqs = await view(VAULT, 'list_requests', { from_index: 0, limit: 100 });
  // Broadcast in nonce order; superseded txs carry broadcast_hash "superseded" and are skipped.
  reqs.sort((a, b) => Number(a.evm_tx?.nonce ?? 0) - Number(b.evm_tx?.nonce ?? 0));
  const sent = [];
  for (const r of reqs) {
    if (!r.evm_tx || !r.signature || r.broadcast_hash) continue;
    const { tx, from, raw, payloadMatches } = finalize(r.evm_tx, r.signature);
    if (!payloadMatches || from.toLowerCase() !== expected.toLowerCase()) {
      console.error(`#${r.id}: signature/payload check failed, not broadcasting`);
      continue;
    }
    const [bal, nonce] = await Promise.all([eth.getBalance(from), eth.getTransactionCount(from)]);
    const need = tx.value + tx.gasLimit * tx.maxFeePerGas;
    if (bal < need) {
      console.log(`${VAULT.split('.')[0]} #${r.id}: vault ${from} has ${ethers.formatEther(bal)} Sepolia ETH, needs ${ethers.formatEther(need)}. Waiting for funding.`);
      continue;
    }
    if (nonce !== tx.nonce) {
      console.log(`${VAULT.split('.')[0]} #${r.id}: chain nonce ${nonce} != signed nonce ${tx.nonce}; waiting for earlier txs`);
      continue;
    }
    const resp = await eth.broadcastTransaction(raw);
    console.log(`${VAULT.split('.')[0]} #${r.id}: broadcast ${resp.hash}  ${explorer(resp.hash)}`);
    await account(st.relayer).callFunction({ contractId: VAULT, methodName: 'record_broadcast', args: { id: r.id, tx_hash: resp.hash } });
    sent.push({ id: r.id, nonce: tx.nonce, to: tx.to, value: ethers.formatEther(tx.value), hash: resp.hash, explorer: explorer(resp.hash) });
    if (process.env.RELAY_WAIT !== '0') {
      let rc;
      try {
        rc = await resp.wait(1, 180_000);
      } catch (e) {
        if (!e.receipt) throw e;
        rc = e.receipt; // mined but reverted (for example out of gas)
      }
      console.log(`${VAULT.split('.')[0]} #${r.id}: mined in block ${rc.blockNumber}, status ${rc.status}, gas ${rc.gasUsed} at ${ethers.formatUnits(rc.gasPrice, 'gwei')} gwei`);
      Object.assign(sent.at(-1), { block: rc.blockNumber, status: rc.status, fee_eth: ethers.formatEther(rc.gasUsed * rc.gasPrice) });
    }
  }
  return sent;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await relayOnce();
  if (!process.argv.includes('--once')) setInterval(() => relayOnce().catch((e) => console.error(e.message)), 10000);
}
