import { createContext, useContext, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Bell, Hourglass, LayoutDashboard, ListTree, Menu, SlidersHorizontal, SquareTerminal, Umbrella, Users, X } from 'lucide-react';
import { Mark } from './Ring';
import { WalletButton } from './WalletButton';
import { Boundary } from './Boundary';
import { DEPLOY, isOpen, useVaultData, type VaultState } from '../lib/useVault';

const Ctx = createContext<VaultState | null>(null);
export function useVault(): VaultState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useVault outside Shell');
  return v;
}

const NAV = [
  { to: '/app', icon: LayoutDashboard, label: 'Overview', end: true },
  { to: '/app/holds', icon: Hourglass, label: 'Holds', count: true },
  { to: '/app/guardians', icon: Users, label: 'Guardians' },
  { to: '/app/policy', icon: SlidersHorizontal, label: 'Policy' },
  { to: '/app/cover', icon: Umbrella, label: 'Cover pool' },
  { to: '/app/activity', icon: ListTree, label: 'Audit log' },
  { to: '/app/alerts', icon: Bell, label: 'Alerts' },
  { to: '/app/attack', icon: SquareTerminal, label: 'Try to drain it' },
];

function Nav({ openCount, onNavigate }: { openCount: number; onNavigate?: () => void }) {
  return (
    <nav className="nav" aria-label="Vault">
      {NAV.map((n) => (
        <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? 'on' : '')} onClick={onNavigate}>
          <n.icon className="ic" aria-hidden />
          {n.label}
          {n.count && openCount > 0 && <span className="ct hot" aria-label={`${openCount} open`}>{openCount}</span>}
        </NavLink>
      ))}
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
  const v = useVaultData();
  const [menu, setMenu] = useState(false);
  const loc = useLocation();
  const openCount = v.data?.requests.filter(isOpen).length ?? 0;
  const crumb = NAV.find((n) => (n.end ? loc.pathname === n.to : loc.pathname.startsWith(n.to)))?.label ?? 'Vault';
  return (
    <Ctx.Provider value={v}>
      <a href="#main" className="skip">Skip to content</a>
      <div className="app">
        <aside className="side">
          <div className="sidein">
            <div className="brand"><Mark />Rescue Room</div>
            <div className="vaultpick" title={DEPLOY.vault}>
              <div className="grow">
                <div className="v ellip">Demo treasury</div>
                <div className="s ellip">{DEPLOY.vault}</div>
              </div>
            </div>
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
