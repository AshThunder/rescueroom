// Describes exactly what each signing page asks the wallet to sign. Nothing here signs.
import type { Config, Request } from './types';
import { DEPLOY } from './useVault';

export interface CallSpec {
  title: string;
  signer: string;
  receiver: string;
  method: string;
  args: Record<string, unknown>;
  deposit: string;
  gasTgas: number;
  effect: string;
}

export function spec(action: string, r: Request | undefined, c: Config, param?: string): CallSpec | null {
  const v = DEPLOY.vault;
  switch (action) {
    case 'rescue':
      if (!r) return null;
      return { title: 'Vote to rescue', signer: 'one of the guardians', receiver: v, method: 'vote_rescue', args: { id: r.id }, deposit: '0', gasTgas: 100,
        effect: `Adds your rescue vote. When ${c.quorum_pct}% of guardians (at least ${c.min_distinct}) agree, the request is blocked, funds move to ${r.asset === 'Near' ? c.safe_near : c.safe_evm}, and the vault freezes.` };
    case 'cancel':
      if (!r) return null;
      return { title: 'Cancel withdrawal', signer: c.owner, receiver: v, method: 'cancel', args: { id: r.id }, deposit: '0', gasTgas: 30,
        effect: 'Cancels your own held request immediately. Nothing moves.' };
    case 'execute':
      if (!r) return null;
      return { title: 'Execute after hold', signer: 'anyone', receiver: v, method: 'execute', args: { id: r.id }, deposit: '0', gasTgas: 300,
        effect: 'Releases the request once its hold has ended. Fails while the hold is running or the vault is frozen.' };
    case 'request':
      return { title: 'New withdrawal', signer: c.owner, receiver: v, method: 'request_withdraw', args: { asset: 'Near', to: 'vendor.testnet', amount: '1000000000000000000000000', memo: 'Invoice' }, deposit: '0', gasTgas: 100,
        effect: 'Within the hot allowance this pays instantly. Beyond it, the watcher scores it and a hold applies.' };
    case 'cover':
      return { title: 'Buy cover', signer: c.owner, receiver: v, method: 'buy_cover', args: { coverage: param || '0' }, deposit: 'the quoted premium', gasTgas: 50,
        effect: `Buys cover for hot-allowance losses. Payouts are capped at the per-incident cap and need guardian approval.` };
    case 'unfreeze':
      return { title: 'Propose unfreeze', signer: 'a guardian (DAO proposal)', receiver: c.guardian_dao, method: 'add_proposal', args: { proposal: { description: 'Unfreeze vault', kind: { FunctionCall: { receiver_id: v, actions: [{ method_name: 'dao_unfreeze', args: 'e30=', deposit: '0', gas: '30000000000000' }] } } } }, deposit: '1 NEAR bond', gasTgas: 100,
        effect: 'Opens a Sputnik DAO proposal. When the council approves it, the DAO calls dao_unfreeze on the vault.' };
    default:
      return null;
  }
}

export function cliCommand(s: CallSpec): string {
  const signer = s.signer.includes(' ') ? '<your-account>.testnet' : s.signer;
  const dep = s.deposit === '0' ? '0 NEAR' : s.deposit.includes('NEAR') ? s.deposit.replace(' bond', '') : '<premium> NEAR';
  return `near contract call-function as-transaction ${s.receiver} ${s.method} \\\n  json-args '${JSON.stringify(s.args)}' \\\n  prepaid-gas '${s.gasTgas} Tgas' attached-deposit '${dep}' \\\n  sign-as ${signer} network-config testnet sign-with-keychain send`;
}
