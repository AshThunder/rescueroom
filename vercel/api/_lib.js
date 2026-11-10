// Shared helpers for the hosted (Vercel) API. Reads public chain data only, except the sandbox route,
// which signs with SANDBOX_AGENT_KEY: a function-call key on the sandbox vault limited to request_withdraw.
// No owner, guardian, DAO, watcher or relayer key is ever configured here.
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, getTransactionLastResult } from 'near-api-js';
import deploy from '../lib/testnet.json' with { type: 'json' };

export const DEPLOY = deploy;
export const RPC_URL = process.env.NEAR_RPC_URL || 'https://test.rpc.fastnear.com';
export const provider = new JsonRpcProvider({ url: RPC_URL });
export const SANDBOX = deploy.sandbox || {};
export const APP_URL = process.env.APP_URL || 'https://rescueroom.vercel.app';

export const view = (contractId, method, args = {}) => provider.callFunction({ contractId, method, args });
export const balance = async (accountId) => (await provider.viewAccount({ accountId })).amount;

export async function call(signer, contractId, methodName, args = {}, { deposit = 0n, gas = 100n * 10n ** 12n } = {}) {
  const res = await signer.callFunctionRaw({ contractId, methodName, args, deposit, gas });
  let value;
  try {
    value = getTransactionLastResult(res);
  } catch {}
  return { hash: res.transaction?.hash || res.transaction_outcome?.id, value, res };
}

export function sandboxAgent() {
  const k = (process.env.SANDBOX_AGENT_KEY || '').trim();
  if (!k || !SANDBOX.vault) return null;
  const kp = KeyPair.fromString(k);
  return { agent: new Account(SANDBOX.vault, provider, new KeyPairSigner(kp)), agentPk: kp.getPublicKey().toString() };
}

export function json(res, code, body, headers = {}) {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json');
  for (const [k, v] of Object.entries({ 'cache-control': 'no-store', ...headers })) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

export const clientIp = (req) => String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
