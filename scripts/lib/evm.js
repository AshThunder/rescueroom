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
