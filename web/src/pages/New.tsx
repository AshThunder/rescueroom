// Create a vault through the factory: one-click demo vault, or a custom vault. One signed transaction each.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, CircleAlert, CircleCheck, LoaderCircle, Plus, ShieldCheck, Trash2, Wallet, Zap } from 'lucide-react';
import { Card, ExtLink, Kv, PageHeader, Tag } from '../components/ui';
import { useToast } from '../components/Toast';
import { useWallet } from '../lib/wallet';
import { FACTORY, setVault } from '../lib/active';
import { view, nearblocksTx } from '../lib/near';
import { nearAmt, parseNear } from '../lib/format';
import factory from '@deploy/factory.json';

const TGAS = 10n ** 12n;
const DEMO_GUARDIANS: string[] = factory.demo_guardians;
const NAME_RE = /^[a-z0-9-]{2,30}$/;
const PENDING = 'rr.pending';
interface Costs { vault_storage: string; registry_fee: string; min_deposit: string; demo_deposit: string }
interface TierRow { score: string; hours: string }

const suggest = (acct: string | null, suffix: string) => `${(acct || 'my').split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 30 - suffix.length - 1) || 'my'}-${suffix}`;
const fullId = (name: string) => `${name}.${FACTORY}`;
const isAccount = (a: string) => /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(a) && a.length >= 2 && a.length <= 64;

async function waitForVault(id: string, tries = 20): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (await view(FACTORY, 'get_vault', { vault: id }).catch(() => null)) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

export function NewVault() {
  const w = useWallet();
  const [costs, setCosts] = useState<Costs | null>(null);
  const [done, setDone] = useState<{ vault: string; demo: boolean; hash: string | null } | null>(null);
  useEffect(() => {
    view<Costs>(FACTORY, 'get_costs').then(setCosts).catch(() => {});
    // Back from a redirect wallet: finish the pending creation.
    const p = localStorage.getItem(PENDING);
    if (p) {
      const { vault, demo } = JSON.parse(p) as { vault: string; demo: boolean };
      waitForVault(vault, 6).then((ok) => {
        localStorage.removeItem(PENDING);
        if (ok) {
          setVault(vault);
          setDone({ vault, demo, hash: new URLSearchParams(location.search).get('transactionHashes') });
        }
      });
    }
  }, []);
  if (done) return <Created {...done} />;
  return (
    <>
      <PageHeader title="Create a vault" sub={<>Each vault is its own NEAR account under <span className="mono">{FACTORY}</span>, owned by you. You pay only the storage it needs on testnet.</>} />
      {!w.accountId && (
        <div className="banner a mt24 small" role="status"><Wallet className="ic amber" aria-hidden /><span className="grow">Connect a NEAR testnet wallet to create a vault. You sign one transaction; nothing leaves testnet.</span><button className="btn sm" onClick={() => w.connect()}>Connect wallet</button></div>
      )}
      <div className="split mt24">
        <DemoCard costs={costs} onDone={setDone} />
        <CustomCard costs={costs} onDone={setDone} />
      </div>
    </>
  );
}

function useCreate(onDone: (d: { vault: string; demo: boolean; hash: string | null }) => void) {
  const w = useWallet();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function create(vault: string, demo: boolean, method: string, args: Record<string, unknown>, deposit: bigint) {
    if (!w.accountId) return w.connect();
    if (await view(FACTORY, 'get_vault', { vault }).catch(() => null)) return toast.push({ tone: 'err', title: 'Name taken', body: `${vault} already exists. Pick another name.` });
    setBusy(true);
    localStorage.setItem(PENDING, JSON.stringify({ vault, demo }));
    try {
      const r = await w.send({ receiver: FACTORY, method, args, deposit, gas: 150n * TGAS });
      const ok = await waitForVault(vault);
      localStorage.removeItem(PENDING);
      if (!ok) throw new Error('The transaction finished but the vault was not registered; your deposit was refunded.');
      setVault(vault);
      onDone({ vault, demo, hash: r.hash });
    } catch (e) {
      localStorage.removeItem(PENDING);
      toast.push({ tone: 'err', title: 'Vault not created', body: (e as Error).message.slice(0, 200) });
    } finally {
      setBusy(false);
    }
  }
  return { busy, create };
}

function DemoCard({ costs, onDone }: { costs: Costs | null; onDone: (d: { vault: string; demo: boolean; hash: string | null }) => void }) {
  const w = useWallet();
  const [name, setName] = useState('');
  const n = name || suggest(w.accountId, 'demo');
  const { busy, create } = useCreate(onDone);
  const deposit = costs ? BigInt(costs.demo_deposit) + BigInt(costs.registry_fee) : null;
  const valid = NAME_RE.test(n);
  return (
    <Card title={<span className="row gap8"><Zap className="ic amber" aria-hidden />One-click demo vault</span>} aside={<Tag tone="a">about 30 seconds</Tag>}>
      <div className="pad stack g16">
        <p className="small t2">A small vault with test guardians, your account as the safe and tight limits. Then press Simulate an attack and watch your own vault hold a drain and get rescued.</p>
        <dl>
          <Kv k="Guardians"><span className="stack g4">{DEMO_GUARDIANS.map((g) => <span key={g} className="row gap8"><span className="mono small">{g.split('.')[0]}</span><Tag tone="a">demo guardian, run by Rescue Room</Tag></span>)}</span></Kv>
          <Kv k="Rescue rule">2 of 3 guardians</Kv>
          <Kv k="Safe account"><span className="mono small">{w.accountId || 'your account'}</span></Kv>
          <Kv k="Hot allowance">0.3 NEAR per day</Kv>
          <Kv k="Holds">1 to 6 hours by score, on a demo clock (1 hour passes in 1 minute)</Kv>
          <Kv k="You attach">{deposit ? <><span className="mono">{nearAmt(deposit, 3)}</span> NEAR: {nearAmt(costs!.demo_deposit, 1)} funds the vault (it is yours and a rescue sends it back to you), {nearAmt(costs!.registry_fee, 3)} pays factory storage</> : '…'}</Kv>
        </dl>
        <div className="field">
          <label htmlFor="demo-name">Vault name</label>
          <div className="row gap8"><input id="demo-name" className="input mono" value={n} onChange={(e) => setName(e.target.value.toLowerCase())} aria-invalid={!valid} maxLength={30} /><span className="small t3 mono nowrap">.{FACTORY.split('.')[0]}…</span></div>
          <span className="hint">{valid ? <span className="mono">{fullId(n)}</span> : '2 to 30 characters: a-z, 0-9 and -'}</span>
        </div>
        <div className="banner small"><CircleAlert className="ic t3" aria-hidden /><span>Demo guardians are keys Rescue Room holds. They auto-vote to rescue held drains on demo vaults. Fine for testnet, never for real funds.</span></div>
        <button className="btn amb lg" disabled={busy || !valid || !deposit} aria-busy={busy} onClick={() => create(fullId(n), true, 'create_demo_vault', { name: n }, deposit!)}>
          {busy ? <LoaderCircle className="ic spin" /> : <Zap className="ic" />}{busy ? 'Creating…' : w.accountId ? 'Create demo vault' : 'Connect wallet to start'}
        </button>
      </div>
    </Card>
  );
}

function CustomCard({ costs, onDone }: { costs: Costs | null; onDone: (d: { vault: string; demo: boolean; hash: string | null }) => void }) {
  const w = useWallet();
  const { busy, create } = useCreate(onDone);
  const [f, setF] = useState({ name: '', label: '', mode: 'council' as 'council' | 'dao', guardians: '', dao: '', role: 'council', quorum: '50', min: '2', safe: '', safeEvm: '', allowance: '1', windowH: '24', ethAllowance: '', floorH: '1', demoClock: false, fund: '0' });
  const [tiers, setTiers] = useState<TierRow[]>([{ score: '0', hours: '1' }, { score: '30', hours: '6' }, { score: '60', hours: '24' }, { score: '80', hours: '72' }]);
  const [tried, setTried] = useState(false);
  const [daoMembers, setDaoMembers] = useState<{ list: string[]; err: string | null } | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string; checked?: boolean; type?: string } }) => setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? !!e.target.checked : e.target.value }));
  const name = f.name || suggest(w.accountId, 'vault');

  useEffect(() => {
    if (f.mode !== 'dao' || !isAccount(f.dao)) return setDaoMembers(null);
    const t = setTimeout(() => {
      view<{ roles: { name: string; kind: { Group?: string[] } | string }[] }>(f.dao, 'get_policy')
        .then((p) => {
          const r = p.roles.find((x) => x.name === f.role);
          const list = r && typeof r.kind === 'object' && r.kind.Group ? r.kind.Group : [];
          setDaoMembers({ list, err: r ? (list.length ? null : 'that role has no members') : `no role named "${f.role}"` });
        })
        .catch(() => setDaoMembers({ list: [], err: 'not a Sputnik DAO on testnet' }));
    }, 400);
    return () => clearTimeout(t);
  }, [f.mode, f.dao, f.role]);

  const guardians = f.mode === 'dao' ? daoMembers?.list ?? [] : [...new Set(f.guardians.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
  const errs = useMemo(() => {
    const e: Record<string, string> = {};
    if (!NAME_RE.test(name)) e.name = '2 to 30 characters: a-z, 0-9 and -';
    if (f.mode === 'council') {
      if (!guardians.length) e.guardians = 'add at least one guardian account';
      else if (guardians.length > 10) e.guardians = 'at most 10 guardians';
      else if (guardians.some((g) => !isAccount(g))) e.guardians = `not a NEAR account: ${guardians.find((g) => !isAccount(g))}`;
      else if (w.accountId && guardians.includes(w.accountId)) e.guardians = 'the owner cannot be a guardian';
    } else if (!isAccount(f.dao)) e.dao = 'enter the DAO account, e.g. mydao.sputnik-v2.testnet';
    else if (daoMembers?.err) e.dao = daoMembers.err;
    const q = Number(f.quorum), m = Number(f.min);
    if (!(q >= 1 && q <= 100)) e.quorum = '1 to 100';
    if (!(Number.isInteger(m) && m >= 1 && m <= Math.max(1, guardians.length))) e.min = `1 to ${Math.max(1, guardians.length)}`;
    if (!isAccount(f.safe)) e.safe = 'a NEAR account that receives rescued funds';
    if (f.safeEvm && !/^0x[0-9a-fA-F]{40}$/.test(f.safeEvm)) e.safeEvm = '0x followed by 40 hex characters';
    if (parseNear(f.allowance) === null) e.allowance = 'a NEAR amount';
    if (!(Number(f.windowH) >= 1 && Number(f.windowH) <= 720)) e.windowH = '1 to 720 hours';
    if (f.ethAllowance && !/^\d+(\.\d{1,18})?$/.test(f.ethAllowance)) e.ethAllowance = 'an ETH amount';
    let prev = -1;
    for (const t of tiers) {
      const s = Number(t.score), h = Number(t.hours);
      if (!(Number.isInteger(s) && s >= 0 && s <= 100 && s > prev) || !(h > 0 && h <= 168)) e.tiers = 'scores rise from 0 to 100; holds are 0 to 168 hours';
      prev = s;
    }
    if (tiers[0]?.score !== '0') e.tiers = 'the first tier starts at score 0';
    if (!(Number(f.floorH) > 0 && Number(f.floorH) <= 168)) e.floorH = '0 to 168 hours';
    if (parseNear(f.fund || '0') === null) e.fund = 'a NEAR amount';
    return e;
  }, [f, tiers, guardians, daoMembers, name, w.accountId]);
  const ok = Object.keys(errs).length === 0;
  const fund = parseNear(f.fund || '0') ?? 0n;
  const deposit = costs ? BigInt(costs.min_deposit) + fund : null;
  const eth = (s: string) => {
    const [a, b = ''] = s.split('.');
    return (BigInt(a) * 10n ** 18n + BigInt((b + '0'.repeat(18)).slice(0, 18))).toString();
  };

  function submit() {
    setTried(true);
    if (!ok) return;
    const setup = {
      label: f.label || null,
      guardians,
      guardian_dao: f.mode === 'dao' ? f.dao : null,
      guardian_role: f.mode === 'dao' ? f.role : null,
      quorum_pct: Number(f.quorum),
      min_distinct: Number(f.min),
      safe_near: f.safe,
      safe_evm: f.safeEvm || null,
      near_allowance: parseNear(f.allowance)!.toString(),
      near_window_secs: Math.round(Number(f.windowH) * 3600),
      eth_allowance: f.ethAllowance ? eth(f.ethAllowance) : null,
      hold_tiers: tiers.map((t) => ({ min_score: Number(t.score), hold_secs: Math.round(Number(t.hours) * 3600) })),
      hold_floor_secs: Math.round(Number(f.floorH) * 3600),
      demo_clock: f.demoClock,
    };
    create(fullId(name), false, 'create_vault', { name, setup }, deposit!);
  }

  const E = ({ k }: { k: string }) => (errs[k] && tried ? <span className="hint" style={{ color: 'var(--red)' }}>{errs[k]}</span> : null);
  return (
    <Card title={<span className="row gap8"><ShieldCheck className="ic t3" aria-hidden />Custom vault</span>}>
      <div className="pad stack g16">
        <div className="grid g2">
          <div className="field"><label htmlFor="c-name">Vault name</label><input id="c-name" className="input mono" value={name} maxLength={30} onChange={(e) => setF((x) => ({ ...x, name: e.target.value.toLowerCase() }))} aria-invalid={tried && !!errs.name} /><E k="name" /></div>
          <div className="field"><label htmlFor="c-label">Label (optional)</label><input id="c-label" className="input" value={f.label} maxLength={48} onChange={set('label')} placeholder="Agent treasury" /></div>
        </div>
        <fieldset className="stack g8" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="small t2" style={{ marginBottom: 6 }}>Guardians</legend>
          <div className="seg" style={{ alignSelf: 'flex-start' }} role="radiogroup" aria-label="Guardian type">
            <button type="button" role="radio" aria-checked={f.mode === 'council'} className={f.mode === 'council' ? 'on' : ''} onClick={() => setF((x) => ({ ...x, mode: 'council' }))}>NEAR accounts</button>
            <button type="button" role="radio" aria-checked={f.mode === 'dao'} className={f.mode === 'dao' ? 'on' : ''} onClick={() => setF((x) => ({ ...x, mode: 'dao' }))}>Sputnik DAO</button>
          </div>
          {f.mode === 'council' ? (
            <div className="field"><label htmlFor="c-g">Guardian accounts</label><textarea id="c-g" className="input mono" style={{ height: 76, padding: '8px 12px' }} value={f.guardians} onChange={set('guardians')} placeholder={'alice.testnet\nbob.testnet\ncarol.testnet'} aria-invalid={tried && !!errs.guardians} /><span className="hint">One per line, up to 10. They vote on the vault directly; config and code stay fixed because no DAO can change them.</span><E k="guardians" /></div>
          ) : (
            <div className="grid g2">
              <div className="field"><label htmlFor="c-dao">DAO account</label><input id="c-dao" className="input mono" value={f.dao} onChange={set('dao')} placeholder="mydao.sputnik-v2.testnet" aria-invalid={tried && !!errs.dao} /><E k="dao" />{daoMembers && !daoMembers.err && <span className="hint">{daoMembers.list.length} members: {daoMembers.list.slice(0, 3).join(', ')}{daoMembers.list.length > 3 ? '…' : ''}</span>}</div>
              <div className="field"><label htmlFor="c-role">Guardian role</label><input id="c-role" className="input mono" value={f.role} onChange={set('role')} /></div>
            </div>
          )}
          <div className="grid g2">
            <div className="field"><label htmlFor="c-q">Quorum %</label><input id="c-q" className="input mono" inputMode="numeric" value={f.quorum} onChange={set('quorum')} aria-invalid={tried && !!errs.quorum} /><E k="quorum" /></div>
            <div className="field"><label htmlFor="c-m">Minimum distinct approvers</label><input id="c-m" className="input mono" inputMode="numeric" value={f.min} onChange={set('min')} aria-invalid={tried && !!errs.min} /><E k="min" /></div>
          </div>
        </fieldset>
        <div className="grid g2">
          <div className="field"><label htmlFor="c-safe">Safe NEAR account</label><input id="c-safe" className="input mono" value={f.safe} onChange={set('safe')} placeholder={w.accountId || 'cold.testnet'} aria-invalid={tried && !!errs.safe} /><span className="hint">Rescued funds go here.</span><E k="safe" /></div>
          <div className="field"><label htmlFor="c-evm">Sepolia safe address (optional)</label><input id="c-evm" className="input mono" value={f.safeEvm} onChange={set('safeEvm')} placeholder="0x…" aria-invalid={tried && !!errs.safeEvm} /><span className="hint">Leave empty to keep Sepolia off.</span><E k="safeEvm" /></div>
        </div>
        <div className="grid g2">
          <div className="field"><label htmlFor="c-a">Hot allowance (NEAR)</label><input id="c-a" className="input mono" value={f.allowance} onChange={set('allowance')} aria-invalid={tried && !!errs.allowance} /><span className="hint">Paid without a hold, per window.</span><E k="allowance" /></div>
          <div className="field"><label htmlFor="c-w">Window (hours)</label><input id="c-w" className="input mono" value={f.windowH} onChange={set('windowH')} aria-invalid={tried && !!errs.windowH} /><E k="windowH" /></div>
        </div>
        {f.safeEvm && <div className="field"><label htmlFor="c-ea">Sepolia hot allowance (ETH, optional)</label><input id="c-ea" className="input mono" value={f.ethAllowance} onChange={set('ethAllowance')} placeholder="0.01" aria-invalid={tried && !!errs.ethAllowance} /><E k="ethAllowance" /></div>}
        <div className="field">
          <label>Hold tiers</label>
          <div className="stack g8">
            {tiers.map((t, i) => (
              <div key={i} className="row gap8">
                <span className="small t3 nowrap">score ≥</span>
                <input className="input mono" style={{ width: 72 }} aria-label={`Tier ${i + 1} minimum score`} value={t.score} onChange={(e) => setTiers((l) => l.map((x, j) => (j === i ? { ...x, score: e.target.value } : x)))} />
                <span className="small t3 nowrap">hold</span>
                <input className="input mono" style={{ width: 80 }} aria-label={`Tier ${i + 1} hold hours`} value={t.hours} onChange={(e) => setTiers((l) => l.map((x, j) => (j === i ? { ...x, hours: e.target.value } : x)))} />
                <span className="small t3 grow">hours</span>
                {tiers.length > 1 && <button type="button" className="btn ghost sm" aria-label={`Remove tier ${i + 1}`} onClick={() => setTiers((l) => l.filter((_, j) => j !== i))}><Trash2 className="ic" /></button>}
              </div>
            ))}
            {tiers.length < 8 && <button type="button" className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => setTiers((l) => [...l, { score: String(Math.min(100, Number(l[l.length - 1]?.score || 0) + 10)), hours: l[l.length - 1]?.hours || '24' }])}><Plus className="ic" />Add tier</button>}
          </div>
          <span className="hint">Requests over the allowance are held. The watcher's risk score picks the hold; until it scores, the longest hold applies.</span>
          <E k="tiers" />
        </div>
        <div className="grid g2">
          <div className="field"><label htmlFor="c-floor">Minimum hold (hours)</label><input id="c-floor" className="input mono" value={f.floorH} onChange={set('floorH')} aria-invalid={tried && !!errs.floorH} /><E k="floorH" /></div>
          <div className="field"><label htmlFor="c-fund">First deposit (NEAR, optional)</label><input id="c-fund" className="input mono" value={f.fund} onChange={set('fund')} aria-invalid={tried && !!errs.fund} /><E k="fund" /></div>
        </div>
        <label className="row gap8 small t2"><input type="checkbox" checked={f.demoClock} onChange={set('demoClock')} />Demo clock: 1 hour of policy time passes in 1 minute</label>
        <div className="card pad stack g8" style={{ background: 'var(--bg0)' }}>
          <div className="row"><span className="grow small t2">Vault storage (locked in your vault)</span><span className="mono small">{costs ? nearAmt(costs.vault_storage, 3) : '…'} NEAR</span></div>
          <div className="row"><span className="grow small t2">Factory registry entry</span><span className="mono small">{costs ? nearAmt(costs.registry_fee, 3) : '…'} NEAR</span></div>
          {fund > 0n && <div className="row"><span className="grow small t2">First deposit</span><span className="mono small">{nearAmt(fund, 3)} NEAR</span></div>}
          <div className="row" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}><span className="grow">You attach</span><span className="mono">{deposit !== null ? nearAmt(deposit, 3) : '…'} NEAR</span></div>
        </div>
        <button className="btn pri lg" disabled={busy || deposit === null || !w.accountId} aria-busy={busy} onClick={submit}>{busy ? <LoaderCircle className="ic spin" /> : <ShieldCheck className="ic" />}{busy ? 'Creating…' : 'Create vault'}</button>
        {!w.accountId && <span className="hint">Connect a wallet first.</span>}
      </div>
    </Card>
  );
}

function Created({ vault, demo, hash }: { vault: string; demo: boolean; hash: string | null }) {
  return (
    <>
      <PageHeader title="Vault created" sub={<><span className="mono">{vault}</span> is live on NEAR testnet and you are its owner. The defender is watching it.</>} />
      <Card className="mt24">
        <div className="pad stack g16">
          <div className="row gap12"><CircleCheck className="ic green" aria-hidden /><span className="grow">Created in one transaction.</span>{hash && <ExtLink href={nearblocksTx(hash)}><span className="mono small">tx</span></ExtLink>}</div>
          {demo ? (
            <>
              <p className="small t2">Your demo vault holds 1.5 NEAR. Simulate an attack: a scripted attacker gets a temporary key, spends inside the allowance, then tries to drain the rest. The drain is held, explained, and the demo guardians rescue it to your account.</p>
              <div className="row gap8 wrap"><Link className="btn amb lg" to="/app/attack"><Zap className="ic" />Simulate an attack</Link><Link className="btn lg" to="/app">Open dashboard<ArrowRight className="ic" /></Link></div>
            </>
          ) : (
            <>
              <p className="small t2">Next: fund the vault, then give your agent a key that can only call <span className="mono">request_withdraw</span>.</p>
              <div className="row gap8 wrap"><Link className="btn amb lg" to="/app/connect">Fund and connect an agent<ArrowRight className="ic" /></Link><Link className="btn lg" to="/app">Open dashboard</Link></div>
            </>
          )}
        </div>
      </Card>
    </>
  );
}
