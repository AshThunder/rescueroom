export type Asset = 'Near' | 'SepoliaEth';
export type Status = 'PendingScore' | 'Held' | 'Executing' | 'Executed' | 'Cancelled' | 'Rescued' | 'Failed';

export interface Signal { code: string; weight: number; detail: string }
export interface Score { score: number; confidence: number; evidence_hash: string; signals: Signal[]; scored_at_ms: string }
export interface EvmTx {
  chain_id: number; nonce: number; max_priority_fee_per_gas: string; max_fee_per_gas: string;
  gas_limit: number; to: string; value: string; payload_hex: string; unsigned_hex: string;
}
export interface Request {
  id: number; asset: Asset; to: string; amount: string; memo: string; requester: string; agent: string | null;
  created_ms: string; release_ms: string; hot: boolean; status: Status; score: Score | null; approvals: string[];
  evm_tx: EvmTx | null; signature: { big_r: string; s: string; recovery_id: number } | null;
  broadcast_hash: string | null; resolved_by: string | null;
}
export interface HoldTier { min_score: number; hold_secs: number }
export interface Config {
  owner: string; guardian_dao: string; guardian_role: string; quorum_pct: number; min_distinct: number;
  watcher: string; watcher_pk: string; relayer: string; safe_near: string; safe_evm: string;
  near_allowance: { limit: string; window_secs: number }; eth_allowance: { limit: string; window_secs: number };
  hold_tiers: HoldTier[]; hold_floor_secs: number; unscored_hold_secs: number;
  evm: { mpc_contract: string; path: string; chain_id: number; max_fee_per_gas: string; max_priority_fee_per_gas: string; gas_limit: number };
  cover: { base_premium_bps: number; per_incident_cap: string; term_secs: number };
  demo_time_divisor: number;
}
export interface VaultStatus {
  near_balance: string; near_available: string; near_hot_remaining: string; eth_hot_remaining: string;
  frozen: boolean; next_request_id: number; evm_nonce: number; guardians: string[]; approvals_needed: number; rescues: number;
}
export interface CoverStats {
  pool_balance: string; active_exposure: string; solvency_bps: number; risk_points: number;
  premium_bps: number; active_policies: number; per_incident_cap: string;
}
export interface Policy { id: number; holder: string; coverage: string; premium: string; start_ms: string; end_ms: string; paid_out: string }
export interface Claim { id: number; policy_id: number; amount: string; request_id: number | null; reason: string; status: 'Pending' | 'Paid' | 'Rejected'; approvals: string[]; payout: string }
export interface Deploy {
  network: string; vault: string; owner: string; dao: string; watcher: string; relayer: string; safe_near: string;
  guardians: string[]; attacker: string; vendor: string; mpc_signer: string; evm_path: string;
  vault_sepolia_address: string; safe_evm: string;
}
