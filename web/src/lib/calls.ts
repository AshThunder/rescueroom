// Describes exactly what each signing page asks the wallet to sign. Nothing here signs.
import type { Claim, Config, Policy, Request } from './types';
import { DEPLOY } from './useVault';

const TGAS = 10n ** 12n;
const YOCTO = 10n ** 24n;

export interface Field {
  name: string;
  label: string;
  kind: 'text' | 'amount' | 'select' | 'number';
  options?: { value: string; label: string }[];
  placeholder?: string;
  hint?: string;
  initial: string;
  mono?: boolean;
}

export interface CallSpec {
  key: string;
  title: string;
  signerLabel: string;
  expectedSigners: string[] | null; // null = anyone may sign
  receiver: string;
  method: string;
  fields: Field[];
  build: (v: Record<string, string>) => { args: Record<string, unknown>; deposit: bigint; depositLabel: string; gas: bigint } | { error: string };
  effect: string;
}

export function parseAmount(s: string, decimals: number): bigint | null {
  const t = s.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [w, f = ''] = t.split('.');
  if (f.length > decimals) return null;
  return BigInt(w) * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

const fixed = (args: Record<string, unknown>, gasT: number, deposit = 0n, depositLabel = 'none') => () => ({ args, deposit, depositLabel, gas: BigInt(gasT) * TGAS });

export interface SpecCtx {
  config: Config;
  request?: Request;
  claim?: Claim;
  policies: Policy[];
  guardians: string[];
  premiumFor?: (coverage: bigint) => bigint | undefined;
  proposalBond?: bigint;
}

export function spec(action: string, id: string | undefined, x: SpecCtx): CallSpec | null {
  const v = DEPLOY.vault;
  const c = x.config;
  const r = x.request;
  const eth = r?.asset === 'SepoliaEth';
  switch (action) {
    case 'rescue':
      if (!r) return null;
      return {
        key: 'rescue', title: 'Vote to rescue', signerLabel: 'a guardian', expectedSigners: x.guardians, receiver: v, method: 'vote_rescue', fields: [],
        build: fixed({ id: r.id }, eth ? 300 : 100),
        effect: `Adds your rescue vote. When ${c.quorum_pct}% of guardians (at least ${c.min_distinct}) agree, every open request is cancelled, ${eth ? `MPC signs a transfer to ${c.safe_evm}` : `the reserve moves to ${c.safe_near}`}, the agent key is revoked and the vault freezes.`,
      };
    case 'cancel':
      if (!r) return null;
      return { key: 'cancel', title: 'Cancel withdrawal', signerLabel: 'the owner', expectedSigners: [c.owner], receiver: v, method: 'cancel', fields: [], build: fixed({ id: r.id }, 30), effect: 'Cancels the held request immediately. Nothing moves.' };
    case 'execute':
      if (!r) return null;
      return { key: 'execute', title: 'Execute after hold', signerLabel: 'anyone', expectedSigners: null, receiver: v, method: 'execute', fields: [], build: fixed({ id: r.id }, eth ? 300 : 100), effect: 'Releases the request once its hold has ended. Fails while the hold is running or the vault is frozen.' };
    case 'request':
      return {
        key: 'request', title: 'New withdrawal', signerLabel: 'the owner or an agent key', expectedSigners: [c.owner], receiver: v, method: 'request_withdraw',
        fields: [
          { name: 'asset', label: 'Asset', kind: 'select', options: [{ value: 'Near', label: 'NEAR' }, { value: 'SepoliaEth', label: 'Sepolia ETH (chain signatures)' }], initial: 'Near' },
          { name: 'to', label: 'Destination', kind: 'text', placeholder: 'vendor.testnet or 0x…', initial: '', mono: true, hint: 'NEAR account for NEAR, 0x address for Sepolia ETH' },
          { name: 'amount', label: 'Amount', kind: 'amount', placeholder: '0.5', initial: '', mono: true },
          { name: 'memo', label: 'Memo', kind: 'text', placeholder: 'Invoice #88', initial: '' },
        ],
        build: (f) => {
          const isEth = f.asset === 'SepoliaEth';
          const amount = parseAmount(f.amount, isEth ? 18 : 24);
          if (!f.to.trim()) return { error: 'Enter a destination' };
          if (isEth ? !/^0x[0-9a-fA-F]{40}$/.test(f.to.trim()) : !/^[a-z0-9._-]{2,64}$/.test(f.to.trim())) return { error: isEth ? 'Use a 0x address with 40 hex characters' : 'Use a NEAR account id such as vendor.testnet' };
          if (!amount || amount <= 0n) return { error: 'Enter an amount above 0' };
          return { args: { asset: f.asset, to: f.to.trim(), amount: amount.toString(), memo: f.memo.trim() || null }, deposit: 0n, depositLabel: 'none', gas: (isEth ? 300n : 100n) * TGAS };
        },
        effect: 'Within the hot allowance this pays instantly. Beyond it, the watcher scores it and a hold applies (never shorter than the policy floor).',
      };
    case 'cover':
      return {
        key: 'cover', title: 'Buy cover', signerLabel: 'the owner', expectedSigners: [c.owner], receiver: v, method: 'buy_cover',
        fields: [{ name: 'coverage', label: 'Coverage (NEAR)', kind: 'amount', initial: id && /^\d{19,}$/.test(id) ? (Number(BigInt(id) / 10n ** 18n) / 1e6).toString() : '1', mono: true, hint: `Payouts capped at the per-incident cap` }],
        build: (f) => {
          const cov = parseAmount(f.coverage, 24);
          if (!cov || cov <= 0n) return { error: 'Enter coverage above 0' };
          const p = x.premiumFor?.(cov);
          if (p === undefined) return { error: 'Fetching the premium quote…' };
          return { args: { coverage: cov.toString() }, deposit: p, depositLabel: `${fmt(p)} NEAR premium`, gas: 50n * TGAS };
        },
        effect: 'Buys cover for hot-allowance losses. The premium is priced by current risk; payouts need guardian approval.',
      };
    case 'fileclaim': {
      const live = x.policies.filter((p) => Number(p.end_ms) > Date.now() && p.paid_out === '0');
      return {
        key: 'fileclaim', title: 'File a cover claim', signerLabel: 'the policy holder', expectedSigners: [c.owner], receiver: v, method: 'file_claim',
        fields: [
          { name: 'policy_id', label: 'Policy', kind: 'select', options: live.length ? live.map((p) => ({ value: String(p.id), label: `#${p.id} · ${fmt(BigInt(p.coverage))} NEAR` })) : [{ value: '', label: 'No active policy' }], initial: live[0] ? String(live[0].id) : '' },
          { name: 'request_id', label: 'Loss request id', kind: 'number', initial: id && id !== 'new' ? id : '', mono: true, hint: 'The hot spend that was lost' },
          { name: 'amount', label: 'Amount lost (NEAR)', kind: 'amount', initial: '', mono: true },
          { name: 'reason', label: 'What happened', kind: 'text', initial: 'Hot allowance drained by stolen agent key' },
        ],
        build: (f) => {
          const a = parseAmount(f.amount, 24);
          if (f.policy_id === '') return { error: 'Buy cover first' };
          if (!a || a <= 0n) return { error: 'Enter the amount lost' };
          return { args: { policy_id: Number(f.policy_id), amount: a.toString(), request_id: f.request_id ? Number(f.request_id) : null, reason: f.reason }, deposit: 0n, depositLabel: 'none', gas: 50n * TGAS };
        },
        effect: 'Opens a claim. Guardians vote on it; once approved the pool pays up to the per-incident cap.',
      };
    }
    case 'claim':
      if (!x.claim) return null;
      return { key: 'claim', title: `Approve claim #${x.claim.id}`, signerLabel: 'a guardian', expectedSigners: x.guardians, receiver: v, method: 'vote_claim', fields: [], build: fixed({ claim_id: x.claim.id }, 100), effect: `Adds your approval. At quorum the pool pays ${fmt(BigInt(x.claim.amount))} NEAR (capped) to the policy holder.` };
    case 'unfreeze': {
      const kind = { FunctionCall: { receiver_id: v, actions: [{ method_name: 'dao_unfreeze', args: 'e30=', deposit: '0', gas: '30000000000000' }] } };
      const bond = x.proposalBond ?? YOCTO;
      return { key: 'unfreeze', title: 'Propose unfreeze', signerLabel: 'a guardian (DAO proposal)', expectedSigners: x.guardians, receiver: c.guardian_dao, method: 'add_proposal', fields: [], build: fixed({ proposal: { description: 'Unfreeze Rescue Room vault after incident review', kind } }, 100, bond, `${fmt(bond)} NEAR bond (refunded on approval)`), effect: 'Opens a Sputnik DAO proposal. When the council approves it, the DAO calls dao_unfreeze on the vault.' };
    }
    default:
      return null;
  }
}

function fmt(y: bigint) {
  const s = (Number(y / 10n ** 18n) / 1e6).toFixed(4);
  return s.replace(/\.?0+$/, '');
}

export function cliCommand(s: CallSpec, b: { args: Record<string, unknown>; deposit: bigint; gas: bigint }, signer?: string | null): string {
  const as = signer || (s.expectedSigners?.length === 1 ? s.expectedSigners[0] : '<your-account>.testnet');
  const dep = b.deposit === 0n ? '0 NEAR' : `${b.deposit.toString()} yoctoNEAR`;
  return `near contract call-function as-transaction ${s.receiver} ${s.method} \\\n  json-args '${JSON.stringify(b.args)}' \\\n  prepaid-gas '${(b.gas / TGAS).toString()} Tgas' attached-deposit '${dep}' \\\n  sign-as ${as} network-config testnet sign-with-keychain send`;
}
