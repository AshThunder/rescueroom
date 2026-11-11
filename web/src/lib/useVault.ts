import { useCallback, useEffect, useRef, useState } from 'react';
import deploy from '@deploy/testnet.json';
import type { Claim, Config, CoverStats, Deploy, Policy, Request, VaultStatus } from './types';
import { nearHeight, sepoliaBalance, sepoliaHeight, view } from './near';
import { FACTORY, isFactoryVault, MAIN_VAULT } from './active';
import { deriveVaultEvm, ZERO_EVM } from './evm';

export const DEPLOY = deploy as Deploy;

export interface FactoryInfo { vault: string; owner: string; demo: boolean; council: boolean; created_ms: string; label: string; alert_webhook: string | null }

export interface VaultData {
  vault: string;
  /** Sepolia address controlled by this vault through chain signatures. */
  evmAddress: string;
  /** Sepolia requests are possible (a Sepolia safe address is set). */
  ethEnabled: boolean;
  /** Guardians act as a council of accounts (no Sputnik DAO). */
  council: boolean;
  /** Factory registry entry (null for the original demo vaults). */
  info: FactoryInfo | null;
  config: Config;
  status: VaultStatus;
  requests: Request[];
  cover: CoverStats;
  policies: Policy[];
  claims: Claim[];
  whitelist: [string, string][];
  agents: [string, { label: string; added_ms: string }][];
  ethBalance: bigint | null;
  nearHeight: number | null;
  sepoliaHeight: number | null;
  updatedAt: number;
}

export interface VaultState {
  data: VaultData | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

const POLL_MS = 5000;

async function load(v: string): Promise<VaultData> {
  const [config, status, requests, cover, policies, claims, whitelist, agents] = await Promise.all([
    view<Config>(v, 'get_config'),
    view<VaultStatus>(v, 'get_status'),
    view<Request[]>(v, 'list_requests', { from_index: 0, limit: 100 }),
    view<CoverStats>(v, 'cover_stats'),
    view<Policy[]>(v, 'list_policies'),
    view<Claim[]>(v, 'list_claims'),
    view<[string, string][]>(v, 'get_whitelist'),
    view<[string, { label: string; added_ms: string }][]>(v, 'get_agents'),
  ]);
  const soft = <T,>(p: Promise<T>) => p.catch(() => null);
  const evmAddress = v === MAIN_VAULT ? DEPLOY.vault_sepolia_address : await deriveVaultEvm(v, config.evm.mpc_contract, config.evm.path).catch(() => '');
  const [ethBalance, nh, sh, info] = await Promise.all([
    evmAddress ? soft(sepoliaBalance(evmAddress)) : Promise.resolve(null),
    soft(nearHeight()),
    soft(sepoliaHeight()),
    isFactoryVault(v) ? soft(view<FactoryInfo | null>(FACTORY, 'get_vault', { vault: v })) : Promise.resolve(null),
  ]);
  return {
    vault: v, evmAddress, ethEnabled: config.safe_evm.toLowerCase() !== ZERO_EVM, council: config.guardian_dao === v, info,
    config, status, requests, cover, policies, claims, whitelist, agents, ethBalance, nearHeight: nh, sepoliaHeight: sh, updatedAt: Date.now(),
  };
}

export function useVaultData(vault: string = DEPLOY.vault): VaultState {
  const [data, setData] = useState<VaultData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const busy = useRef(false);
  const vaultRef = useRef(vault);
  vaultRef.current = vault;
  const refresh = useCallback(() => {
    if (busy.current) return;
    busy.current = true;
    const want = vault;
    load(want)
      .then((d) => {
        if (d.vault !== vaultRef.current) return;
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        busy.current = false;
        setLoading(false);
      });
  }, [vault]);
  useEffect(() => {
    setData((d) => (d && d.vault !== vault ? null : d));
    setLoading(true);
    busy.current = false;
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);
  return { data, error, loading, refresh };
}

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export const isOpen = (r: Request) => r.status === 'PendingScore' || r.status === 'Held';
