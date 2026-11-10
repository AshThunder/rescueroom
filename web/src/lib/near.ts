// Read-only access to NEAR testnet and Sepolia over public JSON-RPC. No keys in the browser.
export const NEAR_RPC = import.meta.env.VITE_NEAR_RPC || 'https://test.rpc.fastnear.com';
export const SEPOLIA_RPC = import.meta.env.VITE_SEPOLIA_RPC || 'https://ethereum-sepolia-rpc.publicnode.com';

async function rpc(url: string, method: string, params: unknown) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'rr', method, params }),
  });
  if (!r.ok) throw new Error(`${method}: HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message || JSON.stringify(j.error)}`);
  return j.result;
}

export async function view<T>(contract: string, method: string, args: object = {}): Promise<T> {
  const res = await rpc(NEAR_RPC, 'query', {
    request_type: 'call_function',
    finality: 'optimistic',
    account_id: contract,
    method_name: method,
    args_base64: btoa(JSON.stringify(args)),
  });
  if (res.error) throw new Error(res.error);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(res.result)));
}

export async function nearHeight(): Promise<number> {
  const s = await rpc(NEAR_RPC, 'block', { finality: 'final' });
  return s.header.height;
}

export async function sepoliaHeight(): Promise<number> {
  return parseInt(await rpc(SEPOLIA_RPC, 'eth_blockNumber', []), 16);
}

export async function sepoliaBalance(addr: string): Promise<bigint> {
  return BigInt(await rpc(SEPOLIA_RPC, 'eth_getBalance', [addr, 'latest']));
}

export const nearblocksTx = (h: string) => `https://testnet.nearblocks.io/txns/${h}`;
export const nearblocksAcct = (a: string) => `https://testnet.nearblocks.io/address/${a}`;
export const etherscanAddr = (a: string) => `https://sepolia.etherscan.io/address/${a}`;
export const etherscanTx = (h: string) => `https://sepolia.etherscan.io/tx/${h}`;
