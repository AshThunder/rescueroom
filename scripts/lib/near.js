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

export const provider = new JsonRpcProvider({ url: RPC_URL });

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

export function hasKey(accountId) {
  return fs.existsSync(keyPath(accountId));
}

export function loadKeyPair(accountId) {
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
  return fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
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
