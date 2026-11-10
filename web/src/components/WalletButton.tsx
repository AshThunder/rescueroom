import { LogOut, Wallet } from 'lucide-react';
import { useWallet } from '../lib/wallet';
import { useToast } from './Toast';
import { acct } from '../lib/format';

export function WalletButton({ compact }: { compact?: boolean }) {
  const w = useWallet();
  const toast = useToast();
  if (w.accountId)
    return (
      <div className="row gap4">
        <span className="tag" title={`${w.accountId} via ${w.walletName}`}><span className="dot g" />{compact ? acct(w.accountId) : w.accountId}</span>
        <button className="btn ghost sm" style={{ padding: '0 8px' }} aria-label="Disconnect wallet" onClick={() => w.disconnect().then(() => toast.push({ title: 'Wallet disconnected' }))}><LogOut className="ic" /></button>
      </div>
    );
  return (
    <button className="btn sm" onClick={() => w.connect().catch((e) => toast.push({ tone: 'err', title: 'Could not open the wallet selector', body: String(e?.message || e) }))}>
      <Wallet className="ic" />{compact ? 'Connect' : 'Connect wallet'}
    </button>
  );
}
