// Shared NEAR testnet helpers. Keys live in ~/.rescueroom/keys (chmod 600), never in the repo.
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from 'near-api-js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const NETWORK = 'testnet';
export const RPC_URL = process.env.NEAR_RPC_URL || 'https://test.rpc.fastnear.com';
export const HOME = process.env.RESCUEROOM_HOME || path.join(os.homedir(), '.rescueroom');
export const KEY_DIR = path.join(HOME, 'keys');
export const STATE_FILE = path.join(HOME, 'deploy.json');

// NEAR_RPC_FALLBACKS (comma list): on rate limits or network errors, rotate to the next RPC.
class RotatingProvider extends JsonRpcProvider {
  constructor(urls) {
    super({ url: urls[0] });
    this.subs = urls.map((url) => new JsonRpcProvider({ url }));
    this.i = 0;
  }
  async sendJsonRpc(method, params) {
    // Transactions: primary RPC only (a lost response must never cause a second send); retry only on
    // rate limits, which mean the request was rejected before processing.
    if (/^(send_tx|broadcast_tx)/.test(method)) {
      for (let k = 0; ; k++) {
        try {
          return await this.subs[0].sendJsonRpc(method, params);
        } catch (e) {
          if (k >= 8 || !/-429|\b429\b|rate limit/i.test(String(e?.message))) throw e;
          await new Promise((r) => setTimeout(r, 1000 + k * 500));
        }
      }
    }
    let last;
    const start = this.i;
    for (let k = 0; k < this.subs.length; k++) {
      const j = (start + k) % this.subs.length;
      try {
        return await this.subs[j].sendJsonRpc(method, params);
      } catch (e) {
        if (!/-429|429|rate limit|fetch failed|ECONN|ETIMEDOUT|socket hang up|timed? ?out|internal server error|bad gateway|unavailable/i.test(String(e?.message))) throw e;
        last = e;
        this.i = (j + 1) % this.subs.length;
      }
    }
    throw last;
  }
}
const FALLBACKS = (process.env.NEAR_RPC_FALLBACKS || '').split(',').map((s) => s.trim()).filter(Boolean);
export const provider = FALLBACKS.length ? new RotatingProvider([RPC_URL, ...FALLBACKS]) : new JsonRpcProvider({ url: RPC_URL });

function ensureDir() {
  fs.mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
}

export function keyPath(accountId) {
  return path.join(KEY_DIR, `${accountId}.json`);
}

/** Create and persist a new ed25519 key for accountId. Returns the public key only. */
export function newKey(accountId) {
  ensureDir();
  const kp = KeyPair.fromRandom('ed25519');
  const file = keyPath(accountId);
  fs.writeFileSync(
    file,
    JSON.stringify({ account_id: accountId, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }),
    { mode: 0o600 },
  );
  fs.chmodSync(file, 0o600);
  return kp.getPublicKey().toString();
}

// Hosted defender: keys arrive as one secret, RR_KEYS = {"<account or key id>": "ed25519:..."}, and never touch disk.
let envKeys = null;
function keysFromEnv() {
  if (envKeys === null) {
    try {
      envKeys = process.env.RR_KEYS ? JSON.parse(process.env.RR_KEYS) : {};
    } catch {
      envKeys = {};
    }
  }
  return envKeys;
}

export function hasKey(accountId) {
  return Boolean(keysFromEnv()[accountId]) || fs.existsSync(keyPath(accountId));
}

export function loadKeyPair(accountId) {
  const k = keysFromEnv()[accountId];
  if (k) return KeyPair.fromString(k);
  const j = JSON.parse(fs.readFileSync(keyPath(accountId), 'utf8'));
  return KeyPair.fromString(j.private_key);
}

export function account(accountId) {
  return new Account(accountId, provider, new KeyPairSigner(loadKeyPair(accountId)));
}

export async function view(contractId, method, args = {}) {
  return provider.callFunction({ contractId, method, args });
}

export async function exists(accountId) {
  try {
    await provider.viewAccount({ accountId });
    return true;
  } catch {
    return false;
  }
}

export function loadState() {
  // RR_STATE_FILE: public deployment facts (account ids only) baked into the hosted defender image.
  const f = process.env.RR_STATE_FILE || STATE_FILE;
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
}

export function saveState(s) {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
}

export const NEAR = 10n ** 24n;
export const near = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 18n;
export const fmtNear = (y) => (Number(BigInt(y) / 10n ** 20n) / 1e4).toFixed(4);

import { getTransactionLastResult } from 'near-api-js';
export const TGAS = 10n ** 12n;

/** Call a method and return { hash, value }. Throws with the contract's panic message on failure. */
export async function call(signer, contractId, methodName, args = {}, { deposit = 0n, gas = 100n * TGAS } = {}) {
  const a = typeof signer === 'string' ? account(signer) : signer;
  const res = await a.callFunctionRaw({ contractId, methodName, args, deposit, gas });
  const hash = res.transaction?.hash || res.transaction_outcome?.id;
  let value;
  try {
    value = getTransactionLastResult(res);
  } catch {
    value = undefined;
  }
  return { hash, value, res };
}
