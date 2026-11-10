import { Ban, CircleCheck, CircleX, Fingerprint, Hourglass, KeyRound, LifeBuoy, ListChecks, Lock, PenLine, Send, Settings2, ShieldCheck, Umbrella, Unlock, Upload, Zap, type LucideIcon } from 'lucide-react';
import type { IndexedEvent } from './api';
import { acct as acctNear, amt, nearAmt, reqId, short } from './format';
const acct = (a: string) => (a.startsWith('0x') ? short(a, 6, 4) : acctNear(a));

export type Group = 'requests' | 'guardians' | 'cover' | 'admin';
export interface Described { icon: LucideIcon; text: string; group: Group; tone?: 'a' | 'g' | 'r'; requestId?: number }

const id = (d: Record<string, unknown>) => (typeof d.id === 'number' ? d.id : undefined);
const n = (v: unknown) => nearAmt(String(v ?? '0'));

export function describeEvent(e: IndexedEvent): Described {
  const d = e.data || {};
  const rid = id(d);
  switch (e.event) {
    case 'withdraw_requested':
      return { icon: d.hot ? Zap : Hourglass, group: 'requests', requestId: rid, text: `${reqId(rid!)} requested: ${amt(d.asset as 'Near', String(d.amount))} to ${acct(String(d.to))}${d.agent ? ` by agent "${d.agent}"` : ''}${d.hot ? ' (hot allowance)' : ''}` };
    case 'risk_scored':
      return { icon: Fingerprint, group: 'requests', requestId: rid, tone: Number(d.score) >= 60 ? 'a' : undefined, text: `Watcher scored ${reqId(rid!)} ${d.score}/100 with signed evidence, hold ${d.hold_secs}s (demo clock)` };
    case 'withdraw_executed':
      return { icon: CircleCheck, group: 'requests', requestId: rid, tone: 'g', text: `${reqId(rid!)} paid out` };
    case 'execute_started':
      return { icon: Send, group: 'requests', requestId: rid, text: `${reqId(rid!)} released after its hold` };
    case 'request_cancelled':
      return { icon: Ban, group: 'requests', requestId: rid, text: `${reqId(rid!)} cancelled${d.by ? ` by ${acct(String(d.by))}` : ''}${d.reason ? ` (${d.reason})` : ''}` };
    case 'transfer_failed':
    case 'sign_failed':
      return { icon: CircleX, group: 'requests', requestId: rid, tone: 'r', text: `${reqId(rid!)} ${e.event === 'sign_failed' ? 'MPC signing' : 'transfer'} failed` };
    case 'evm_sign_requested':
      return { icon: PenLine, group: 'requests', requestId: rid, text: `MPC signature requested for ${reqId(rid!)} (Sepolia)` };
    case 'evm_signed':
      return { icon: PenLine, group: 'requests', requestId: rid, tone: 'g', text: `MPC signed the Sepolia transaction for ${reqId(rid!)}${d.rescue ? ' (rescue to safe address)' : ''}` };
    case 'evm_broadcast':
      return { icon: Send, group: 'requests', requestId: rid, text: `Relayer broadcast ${reqId(rid!)} to Sepolia` };
    case 'rescue_vote':
      return { icon: LifeBuoy, group: 'guardians', requestId: rid, text: `${acct(String(d.guardian))} voted to rescue ${reqId(rid!)} (${d.approvals} of ${d.needed})` };
    case 'rescue_executed':
      return { icon: ShieldCheck, group: 'guardians', requestId: rid, tone: 'g', text: `Rescued ${reqId(rid!)}: ${d.asset === 'Near' ? `${n(d.amount)} NEAR reserve to ${acct(String(d.safe))}` : 'MPC transfer to the safe address'}; vault frozen` };
    case 'rescue_sent':
      return { icon: Send, group: 'guardians', requestId: rid, tone: 'g', text: `Reserve arrived at the safe account` };
    case 'agent_revoked':
      return { icon: KeyRound, group: 'guardians', tone: 'a', text: `Agent key revoked during rescue` };
    case 'vault_unfrozen':
      return { icon: Unlock, group: 'guardians', text: `Vault unfrozen by ${acct(String(d.by))}` };
    case 'guardians_synced':
      return { icon: ListChecks, group: 'guardians', text: `Guardians synced from the DAO council` };
    case 'cover_deposit':
      return { icon: Umbrella, group: 'cover', text: `${n(d.amount)} NEAR added to the cover pool` };
    case 'cover_bought':
      return { icon: Umbrella, group: 'cover', text: `Cover bought${d.coverage ? `: ${n(d.coverage)} NEAR` : ''}` };
    case 'claim_filed':
      return { icon: Umbrella, group: 'cover', tone: 'a', text: `Claim #${d.claim} filed for ${n(d.amount)} NEAR${typeof d.request_id === 'number' ? ` (${reqId(d.request_id)})` : ''}` };
    case 'claim_vote':
      return { icon: Umbrella, group: 'cover', text: `${acct(String(d.guardian))} approved claim #${d.claim} (${d.approvals} of ${d.needed})` };
    case 'claim_paid':
      return { icon: Umbrella, group: 'cover', tone: 'g', text: `Claim #${d.claim} paid ${n(d.payout)} NEAR` };
    case 'agent_added':
      return { icon: KeyRound, group: 'admin', text: `Agent key added${d.label ? ` ("${d.label}")` : ''}` };
    case 'agent_removed':
      return { icon: KeyRound, group: 'admin', text: 'Agent key removed' };
    case 'whitelist_added':
      return { icon: ListChecks, group: 'admin', text: `Whitelisted ${acct(String(d.destination))}` };
    case 'whitelist_removed':
      return { icon: ListChecks, group: 'admin', text: `Removed ${acct(String(d.destination))} from the whitelist` };
    case 'allowance_tightened':
      return { icon: Lock, group: 'admin', text: 'Owner tightened the hot allowance' };
    case 'config_updated':
      return { icon: Settings2, group: 'admin', text: 'Config changed by DAO proposal' };
    case 'upgrade_started':
      return { icon: Upload, group: 'admin', tone: 'a', text: `DAO upgraded the vault code (sha256 ${String(d.code_sha256).slice(0, 10)}…)` };
    case 'upgraded':
      return { icon: Upload, group: 'admin', tone: 'g', text: `Vault now on version ${d.version}` };
    case 'vault_created':
      return { icon: Settings2, group: 'admin', text: 'Vault created' };
    default:
      return { icon: Settings2, group: 'admin', text: e.event.replace(/_/g, ' ') };
  }
}
