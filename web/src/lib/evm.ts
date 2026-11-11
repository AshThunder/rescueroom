// A vault's Sepolia address, derived from the MPC signer (chain signatures): keccak256 of the derived
// secp256k1 public key, last 20 bytes. Read-only; same derivation as scripts/lib/evm.js.
import { keccak_256 } from '@noble/hashes/sha3';
import { b58decode } from './b58';
import { view } from './near';

const cache = new Map<string, string>();

function checksum(hexAddr: string) {
  const h = Array.from(keccak_256(new TextEncoder().encode(hexAddr)), (b) => b.toString(16).padStart(2, '0')).join('');
  return '0x' + [...hexAddr].map((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join('');
}

export async function deriveVaultEvm(vault: string, mpc: string, path: string): Promise<string> {
  const k = `${vault}|${mpc}|${path}`;
  const hit = cache.get(k);
  if (hit) return hit;
  const pk = await view<string>(mpc, 'derived_public_key', { path, predecessor: vault, domain_id: 0 });
  const raw = b58decode(pk.split(':')[1]); // 64 bytes, uncompressed without the 0x04 prefix
  const hash = keccak_256(raw);
  const addr = checksum(Array.from(hash.slice(12), (b) => b.toString(16).padStart(2, '0')).join(''));
  cache.set(k, addr);
  return addr;
}

export const ZERO_EVM = '0x0000000000000000000000000000000000000000';
