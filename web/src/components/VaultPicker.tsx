// Vault picker: the demo vaults, the connected account's factory vaults and recently opened ones.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, ChevronsUpDown, Plus } from 'lucide-react';
import { FACTORY, MAIN_VAULT, SANDBOX_VAULT, isFactoryVault, recentVaults, setVault, useActiveVault, vaultSlug } from '../lib/active';
import { useWallet } from '../lib/wallet';
import { view } from '../lib/near';
import type { FactoryInfo } from '../lib/useVault';

export function vaultLabel(v: string, info?: FactoryInfo | null) {
  if (v === MAIN_VAULT) return 'Demo treasury';
  if (v === SANDBOX_VAULT) return 'Attacker sandbox';
  return info?.demo ? `${vaultSlug(v)} (demo)` : vaultSlug(v);
}

export function useMyVaults() {
  const w = useWallet();
  const [mine, setMine] = useState<FactoryInfo[]>([]);
  useEffect(() => {
    if (!w.accountId) return setMine([]);
    let live = true;
    view<FactoryInfo[]>(FACTORY, 'vaults_of', { owner: w.accountId }).then((l) => live && setMine(l)).catch(() => {});
    return () => {
      live = false;
    };
  }, [w.accountId]);
  return mine;
}

export function VaultPicker({ onPick }: { onPick?: () => void }) {
  const vault = useActiveVault();
  const mine = useMyVaults();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  const mineIds = mine.map((m) => m.vault);
  const recent = recentVaults().filter((v) => !mineIds.includes(v));
  const info = mine.find((m) => m.vault === vault);
  const pick = (v: string) => {
    setVault(v);
    setOpen(false);
    onPick?.();
  };
  const Item = ({ v, sub }: { v: string; sub?: string }) => (
    <button type="button" role="option" aria-selected={v === vault} className={`vp-item${v === vault ? ' on' : ''}`} onClick={() => pick(v)}>
      <span className="grow">
        <span className="v ellip">{vaultLabel(v, mine.find((m) => m.vault === v))}</span>
        <span className="s ellip">{sub ?? v}</span>
      </span>
      {v === vault && <Check className="ic" aria-hidden />}
    </button>
  );
  return (
    <div className="vp" ref={ref}>
      <button type="button" className="vaultpick" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)} title={vault}>
        <span className="grow" style={{ minWidth: 0, textAlign: 'left' }}>
          <span className="v ellip" style={{ display: 'block' }}>{vaultLabel(vault, info)}</span>
          <span className="s ellip" style={{ display: 'block' }}>{vault}</span>
        </span>
        <ChevronsUpDown className="ic t3" aria-hidden />
      </button>
      {open && (
        <div className="vp-menu" role="listbox" aria-label="Vaults">
          <div className="vp-group">Demo</div>
          <Item v={MAIN_VAULT} />
          <Item v={SANDBOX_VAULT} />
          {mine.length > 0 && <div className="vp-group">Your vaults</div>}
          {mine.map((m) => <Item key={m.vault} v={m.vault} />)}
          {recent.filter(isFactoryVault).length > 0 && <div className="vp-group">Recently opened</div>}
          {recent.filter(isFactoryVault).map((v) => <Item key={v} v={v} />)}
          <Link className="vp-item vp-new" to="/app/new" onClick={() => { setOpen(false); onPick?.(); }}><Plus className="ic" aria-hidden /><span className="grow">Create a vault</span></Link>
        </div>
      )}
    </div>
  );
}
