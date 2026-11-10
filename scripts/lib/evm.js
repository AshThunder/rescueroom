// Rebuild the vault's EIP-1559 tx with ethers, check it matches what the MPC signed,
// attach the MPC signature, and verify the recovered sender is the vault's derived address.
import { ethers } from 'ethers';

export const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';

export function rebuild(evmTx) {
  return ethers.Transaction.from({
    type: 2,
    chainId: BigInt(evmTx.chain_id),
    nonce: Number(evmTx.nonce),
    maxPriorityFeePerGas: BigInt(evmTx.max_priority_fee_per_gas),
    maxFeePerGas: BigInt(evmTx.max_fee_per_gas),
    gasLimit: BigInt(evmTx.gas_limit),
    to: ethers.getAddress(evmTx.to),
    value: BigInt(evmTx.value),
    data: '0x',
    accessList: [],
  });
}

/** Returns { tx, from, raw, payloadMatches } */
export function finalize(evmTx, sig) {
  const tx = rebuild(evmTx);
  const payloadMatches = tx.unsignedHash.slice(2).toLowerCase() === evmTx.payload_hex.toLowerCase();
  const r = '0x' + sig.big_r.slice(2); // drop compressed-point prefix byte -> x coordinate
  const s = '0x' + sig.s;
  tx.signature = ethers.Signature.from({ r, s, v: 27 + Number(sig.recovery_id) });
  return { tx, from: tx.from, raw: tx.serialized, payloadMatches };
}

/** The vault's Sepolia address, derived from the MPC signer (same derivation as deploy.mjs). */
export async function deriveVaultEvm(view, vaultId) {
  const cfg = await view(vaultId, 'get_config');
  const pk = await view(cfg.evm.mpc_contract, 'derived_public_key', { path: cfg.evm.path, predecessor: vaultId, domain_id: 0 });
  const bs58 = (await import('./bs58.js')).default;
  const raw = bs58.decode(pk.split(':')[1]);
  return ethers.computeAddress('0x04' + Buffer.from(raw).toString('hex'));
}
