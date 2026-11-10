// Relayer: broadcasts MPC-signed Sepolia transactions and records the tx hash on the vault.
// It cannot change destination or amount: those are fixed inside the signed payload.
// Usage: node scripts/relayer.mjs [--once]
import { ethers } from 'ethers';
import { account, view, loadState } from './lib/near.js';
import { finalize, SEPOLIA_RPC } from './lib/evm.js';

const st = loadState();
const VAULT = process.env.VAULT || st.vault;
const eth = new ethers.JsonRpcProvider(SEPOLIA_RPC);

export async function relayOnce() {
  const reqs = await view(VAULT, 'list_requests', { from_index: 0, limit: 100 });
  for (const r of reqs.reverse()) {
    if (!r.evm_tx || !r.signature || r.broadcast_hash) continue;
    const { tx, from, raw, payloadMatches } = finalize(r.evm_tx, r.signature);
    if (!payloadMatches || from.toLowerCase() !== st.vault_evm.toLowerCase()) {
      console.error(`#${r.id}: signature/payload check failed, not broadcasting`);
      continue;
    }
    const [bal, nonce] = await Promise.all([eth.getBalance(from), eth.getTransactionCount(from)]);
    const need = tx.value + tx.gasLimit * tx.maxFeePerGas;
    if (bal < need) {
      console.log(`#${r.id}: vault ${from} has ${ethers.formatEther(bal)} Sepolia ETH, needs ${ethers.formatEther(need)}. Waiting for funding.`);
      continue;
    }
    if (nonce !== tx.nonce) {
      console.log(`#${r.id}: chain nonce ${nonce} != signed nonce ${tx.nonce}; waiting for earlier txs`);
      continue;
    }
    const sent = await eth.broadcastTransaction(raw);
    console.log(`#${r.id}: broadcast ${sent.hash}`);
    await account(st.relayer).callFunction({ contractId: VAULT, methodName: 'record_broadcast', args: { id: r.id, tx_hash: sent.hash } });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await relayOnce();
  if (!process.argv.includes('--once')) setInterval(() => relayOnce().catch((e) => console.error(e.message)), 10000);
}
