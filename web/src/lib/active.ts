// The vault every /app page shows. Set from ?vault= (deep links from alerts), the vault picker or the
// last choice (localStorage). Only Rescue Room vaults are accepted: the demo vaults and factory vaults.
import { useSyncExternalStore } from 'react';
import deploy from '@deploy/testnet.json';
import sandbox from '@deploy/sandbox.json';
import factory from '@deploy/factory.json';

export const FACTORY: string = factory.factory;
export const MAIN_VAULT: string = deploy.vault;
export const SANDBOX_VAULT: string = sandbox.vault;
const KEY = 'rr.vault';
const RECENT = 'rr.recent';

export function isRescueVault(v: string | null | undefined): v is string {
  if (!v) return false;
  return v === MAIN_VAULT || v === SANDBOX_VAULT || (v.endsWith(`.${FACTORY}`) && /^[a-z0-9-]{2,32}$/.test(v.slice(0, -FACTORY.length - 1)));
}
export const isFactoryVault = (v: string) => v.endsWith(`.${FACTORY}`);
export const vaultSlug = (v: string) => (v === MAIN_VAULT ? 'demo' : v === SANDBOX_VAULT ? 'sandbox' : v.slice(0, -FACTORY.length - 1));

function initial(): string {
  try {
    const q = new URLSearchParams(window.location.search).get('vault');
    if (isRescueVault(q)) return q;
    const s = localStorage.getItem(KEY);
    if (isRescueVault(s)) return s;
  } catch {
    /* no storage */
  }
  return MAIN_VAULT;
}

let current = typeof window === 'undefined' ? MAIN_VAULT : initial();
const subs = new Set<() => void>();

export function getVault() {
  return current;
}

export function recentVaults(): string[] {
  try {
    return (JSON.parse(localStorage.getItem(RECENT) || '[]') as string[]).filter(isRescueVault);
  } catch {
    return [];
  }
}

export function setVault(v: string) {
  if (!isRescueVault(v) || v === current) return;
  current = v;
  try {
    localStorage.setItem(KEY, v);
    if (isFactoryVault(v)) localStorage.setItem(RECENT, JSON.stringify([v, ...recentVaults().filter((x) => x !== v)].slice(0, 8)));
  } catch {
    /* no storage */
  }
  subs.forEach((f) => f());
}

export function useActiveVault(): string {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => current,
  );
}
