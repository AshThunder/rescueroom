import { useCallback, useEffect, useRef, useState } from 'react';
import deploy from '@deploy/testnet.json';
import type { Claim, Config, CoverStats, Deploy, Policy, Request, VaultStatus } from './types';
import { nearHeight, sepoliaBalance, sepoliaHeight, view } from './near';

export const DEPLOY = deploy as Deploy;

export interface VaultData {
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

async function load(): Promise<VaultData> {
  const v = DEPLOY.vault;
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
  const [ethBalance, nh, sh] = await Promise.all([soft(sepoliaBalance(DEPLOY.vault_sepolia_address)), soft(nearHeight()), soft(sepoliaHeight())]);
  return { config, status, requests, cover, policies, claims, whitelist, agents, ethBalance, nearHeight: nh, sepoliaHeight: sh, updatedAt: Date.now() };
}

export function useVaultData(): VaultState {
  const [data, setData] = useState<VaultData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const busy = useRef(false);
  const refresh = useCallback(() => {
    if (busy.current) return;
    busy.current = true;
    load()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        busy.current = false;
        setLoading(false);
      });
  }, []);
  useEffect(() => {
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
