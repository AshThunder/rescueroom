import { createContext, useContext, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Bell, Hourglass, KeyRound, LayoutDashboard, ListTree, Menu, Plus, SlidersHorizontal, SquareTerminal, Umbrella, Users, X } from 'lucide-react';
import { Mark } from './Ring';
import { WalletButton } from './WalletButton';
import { Boundary } from './Boundary';
import { isOpen, useVaultData, type VaultState } from '../lib/useVault';
import { isFactoryVault, isRescueVault, setVault, useActiveVault } from '../lib/active';
import { VaultPicker } from './VaultPicker';

const Ctx = createContext<VaultState | null>(null);
export function useVault(): VaultState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useVault outside Shell');
  return v;
}

const navFor = (factory: boolean) => [
  { to: '/app', icon: LayoutDashboard, label: 'Overview', end: true },
  { to: '/app/holds', icon: Hourglass, label: 'Holds', count: true },
  { to: '/app/guardians', icon: Users, label: 'Guardians' },
  { to: '/app/policy', icon: SlidersHorizontal, label: 'Policy' },
  { to: '/app/cover', icon: Umbrella, label: 'Cover pool' },
  { to: '/app/activity', icon: ListTree, label: 'Audit log' },
  { to: '/app/alerts', icon: Bell, label: 'Alerts' },
  { to: '/app/connect', icon: KeyRound, label: 'Fund and agents' },
  { to: '/app/attack', icon: SquareTerminal, label: factory ? 'Simulate an attack' : 'Try to drain it' },
];
const NEW = { to: '/app/new', icon: Plus, label: 'Create a vault' };

function Nav({ openCount, onNavigate }: { openCount: number; onNavigate?: () => void }) {
  const factory = isFactoryVault(useActiveVault());
  return (
    <nav className="nav" aria-label="Vault">
      {navFor(factory).map((n) => (
        <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? 'on' : '')} onClick={onNavigate}>
          <n.icon className="ic" aria-hidden />
          {n.label}
          {n.count && openCount > 0 && <span className="ct hot" aria-label={`${openCount} open`}>{openCount}</span>}
        </NavLink>
      ))}
      <div className="navlabel">Get started</div>
      <NavLink to={NEW.to} className={({ isActive }) => (isActive ? 'on' : '')} onClick={onNavigate}><NEW.icon className="ic" aria-hidden />{NEW.label}</NavLink>
    </nav>
  );
}

function ChainFoot({ v }: { v: VaultState }) {
  const d = v.data;
  return (
    <div className="foot">
      <div className="row gap8 small t2">
        <span className={`dot ${v.error ? 'r' : d?.nearHeight ? 'g' : ''}`} />NEAR testnet
        <span className="mono t3 right">{d?.nearHeight ? `blk ${d.nearHeight.toLocaleString('en-US')}` : '…'}</span>
      </div>
      <div className="row gap8 small t2">
        <span className={`dot ${d?.sepoliaHeight ? 'g' : ''}`} />Sepolia
        <span className="mono t3 right">{d?.sepoliaHeight ? `blk ${d.sepoliaHeight.toLocaleString('en-US')}` : '…'}</span>
      </div>
    </div>
  );
}

export function Shell() {
  const loc = useLocation();
  // Deep links (alerts, simulate results) carry ?vault=<id>.
  useEffect(() => {
    const q = new URLSearchParams(loc.search).get('vault');
    if (isRescueVault(q)) setVault(q);
  }, [loc.search]);
  const vault = useActiveVault();
  const v = useVaultData(vault);
  const [menu, setMenu] = useState(false);
  const openCount = v.data?.requests.filter(isOpen).length ?? 0;
  const crumb = [...navFor(isFactoryVault(vault)), NEW].find((n) => ('end' in n && n.end ? loc.pathname === n.to : loc.pathname.startsWith(n.to)))?.label ?? 'Vault';
  return (
    <Ctx.Provider value={v}>
      <a href="#main" className="skip">Skip to content</a>
      <div className="app">
        <aside className="side">
          <div className="sidein">
            <div className="brand"><Mark />Rescue Room</div>
            <VaultPicker />
            <div className="navlabel">Vault</div>
            <Nav openCount={openCount} />
            <ChainFoot v={v} />
          </div>
        </aside>
        <div className="main">
          <div className="mbar">
            <div className="brand" style={{ padding: 0 }}><Mark />Rescue Room</div>
            <span className="grow" />
            {openCount > 0 && <span className="tag a"><span className="dot a" />{openCount} open</span>}
            <WalletButton compact />
            <button className="btn ghost sm" aria-label={menu ? 'Close menu' : 'Open menu'} aria-expanded={menu} onClick={() => setMenu(!menu)} style={{ padding: '0 8px' }}>
              {menu ? <X className="ic lg" /> : <Menu className="ic lg" />}
            </button>
          </div>
          {menu && (
            <div className="drawer">
              <div style={{ padding: '0 0 12px' }}><VaultPicker onPick={() => setMenu(false)} /></div>
              <Nav openCount={openCount} onNavigate={() => setMenu(false)} />
            </div>
          )}
          <div className="top">
            <div className="crumb"><b>{crumb}</b></div>
            <span className="grow" />
            <span className="small t3 mono hide-narrow">{v.data ? `updated ${new Date(v.data.updatedAt).toLocaleTimeString('en-GB', { timeZone: 'Africa/Lagos' })} WAT` : ''}</span>
            <WalletButton />
          </div>
          <main id="main" className="page">
            <Boundary key={loc.pathname}><Outlet /></Boundary>
          </main>
        </div>
      </div>
    </Ctx.Provider>
  );
}
