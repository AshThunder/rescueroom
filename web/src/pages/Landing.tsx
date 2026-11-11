import { Link } from 'react-router-dom';
import { ArrowRight, ExternalLink, KeyRound, Bot, Users, Hourglass, LifeBuoy, ShieldCheck, SquareTerminal } from 'lucide-react';
import { Mark, Ring } from '../components/Ring';
import { DEPLOY, isOpen, useVaultData } from '../lib/useVault';
import { nearAmt, short } from '../lib/format';
import sepoliaLive from '@deploy/sepolia-live.json';

const PROBLEMS = [
  { icon: KeyRound, t: 'Keys get stolen', d: 'One leaked key is enough to drain a treasury, and on-chain transfers are final in seconds.' },
  { icon: Bot, t: 'Agents get broad permissions', d: 'AI agents that pay vendors need spending rights. A confused or hijacked agent spends just as fast.' },
  { icon: Users, t: 'Multisigs are all or nothing', d: 'Requiring every payment to be co-signed slows the team down, so limits end up loose.' },
];

const STEPS = [
  { n: '01', t: 'Request', d: 'Every withdrawal goes through the vault. Small spends inside the hot allowance pay instantly.' },
  { n: '02', t: 'Score and hold', d: 'A watcher scores anything bigger and signs its evidence. Risk sets the hold, never below the policy floor.' },
  { n: '03', t: 'Rescue or release', d: 'During the hold, two of three DAO guardians can rescue the reserve to a safe address. Otherwise it pays out.' },
];

const THREATS: [string, string][] = [
  ['Stolen agent key', 'Can only request. Loss is capped at the hot allowance; the rest is held and the key is revoked on rescue.'],
  ['Stolen owner key', 'Cannot raise limits, change guardians or the safe address. Large requests still wait for a hold.'],
  ['Compromised watcher', 'Scores must carry its signature, and no score can shorten a hold below the floor.'],
  ['Relayer', 'Only broadcasts. Destination, amount and fees are fixed inside the MPC-signed payload.'],
  ['Deployer', 'The vault has no access keys. Code changes need a DAO proposal.'],
];

function LiveVault() {
  const { data } = useVaultData();
  const s = data?.status;
  const c = data?.config;
  const open = data?.requests.filter(isOpen).length ?? null;
  const live = sepoliaLive as unknown as { sepolia?: { hash: string; value: string; to: string }[] };
  const rescue = live.sepolia?.[1];
  const rows: [string, string][] = [
    ['Reserve', s ? `${nearAmt(s.near_available)} NEAR` : '…'],
    ['Hot allowance left', s ? `${nearAmt(s.near_hot_remaining)} NEAR` : '…'],
    ['Open holds', open === null ? '…' : String(open)],
    ['Guardians', s ? `${s.approvals_needed} of ${s.guardians.length}` : '…'],
    ['Rescues so far', s ? String(s.rescues) : '…'],
    ['Hold floor', c ? `${Math.round(c.hold_floor_secs / 60)} min policy` : '…'],
  ];
  return (
    <div className="card">
      <div className="chead"><h3>{DEPLOY.vault}</h3>{s && <span className={`tag ${s.frozen ? 'r' : 'g'}`}>{s.frozen ? 'frozen' : 'live'}</span>}</div>
      <dl className="lgrid">
        {rows.map(([k, v]) => (
          <div key={k} className="lcell"><dt className="small t3">{k}</dt><dd className="mono">{v}</dd></div>
        ))}
      </dl>
      <div className="pad row gap16 wrap small">
        <a className="link" href={`https://testnet.nearblocks.io/address/${DEPLOY.vault}`} target="_blank" rel="noreferrer">Vault on NearBlocks <ExternalLink className="ic" style={{ width: 12, height: 12 }} /></a>
        {rescue && <a className="link" href={`https://sepolia.etherscan.io/tx/${rescue.hash}`} target="_blank" rel="noreferrer">Live Sepolia rescue {short(rescue.hash, 8, 4)} <ExternalLink className="ic" style={{ width: 12, height: 12 }} /></a>}
      </div>
    </div>
  );
}

export function Landing() {
  return (
    <div className="land">
      <header className="land-top">
        <div className="brand" style={{ padding: 0 }}><Mark />Rescue Room</div>
        <span className="grow" />
        <nav className="row gap24 hide-m small" aria-label="Sections">
          <a className="t2" href="#how">How it works</a>
          <a className="t2" href="#live">Live vault</a>
          <a className="t2" href="#threats">Threat model</a>
        </nav>
        <Link className="btn sm pri" to="/app">Open the demo vault</Link>
      </header>
      <main id="main">
        <section className="land-sec land-hero">
          <div>
            <span className="tag a">NEAR testnet · Sepolia via chain signatures</span>
            <h1 className="land-h1">Stop a treasury drain while it is still happening.</h1>
            <p className="land-lead">Rescue Room is a hold-and-rescue layer for DAO treasuries and AI agents on NEAR. Everyday spends go straight through. Anything unusual waits, with a plain explanation, while your guardians decide.</p>
            <div className="row gap12 mt32 wrap">
              <Link className="btn lg amb" to="/app">See the live vault <ArrowRight className="ic" /></Link>
              <Link className="btn lg" to="/app/attack"><SquareTerminal className="ic" />Try to drain it</Link>
            </div>
          </div>
          <div className="card pad24 stack g16 land-ring">
            <Ring size={220} frac={0.38}>
              <span className="fig" style={{ fontSize: 32, lineHeight: '38px' }}>3h 42m</span>
              <span className="small t3">left of a 6h hold</span>
            </Ring>
            <div className="small t2" style={{ textAlign: 'center' }}>2 NEAR to a wallet this vault has never paid. Risk 75. Two of three guardians needed to rescue.</div>
          </div>
        </section>

        <section className="land-sec" aria-labelledby="problem">
          <div className="eyebrow">The problem</div>
          <h2 id="problem" className="land-h2">Treasuries move faster than the people who guard them.</h2>
          <div className="grid g3 mt24">
            {PROBLEMS.map((p) => (
              <div key={p.t} className="card pad24 stack g12">
                <p.icon className="ic lg t2" aria-hidden />
                <h3 className="h3">{p.t}</h3>
                <p className="t2 cap">{p.d}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="how" className="land-sec" aria-labelledby="how-h">
          <div className="eyebrow">How it works</div>
          <h2 id="how-h" className="land-h2">Three steps, all enforced by the vault contract.</h2>
          <ol className="steps mt24">
            {STEPS.map((s) => (
              <li key={s.n} className="card pad24 stack g12">
                <span className="mono amber">{s.n}</span>
                <h3 className="h3">{s.t}</h3>
                <p className="t2 cap">{s.d}</p>
              </li>
            ))}
          </ol>
          <div className="row gap24 wrap mt24 small t2">
            <span className="row gap8"><Hourglass className="ic t3" aria-hidden />Holds from 0 to 6 hours by risk</span>
            <span className="row gap8"><LifeBuoy className="ic t3" aria-hidden />Rescue only to a pre-set safe address</span>
            <span className="row gap8"><ShieldCheck className="ic t3" aria-hidden />Cover pool for hot-allowance losses</span>
          </div>
        </section>

        <section id="live" className="land-sec split land-live" aria-labelledby="live-h">
          <div>
            <div className="eyebrow">Live demo vault</div>
            <h2 id="live-h" className="land-h2">Read straight from NEAR testnet.</h2>
            <p className="t2 mt16" style={{ maxWidth: '36rem' }}>The demo treasury has no access keys of its own; only its guardian DAO can upgrade it. Its Sepolia ETH is controlled through NEAR chain signatures, and a real rescue to the safe address is on Sepolia.</p>
            <Link className="btn mt24" to="/app">Open the dashboard <ArrowRight className="ic" /></Link>
          </div>
          <LiveVault />
        </section>

        <section className="land-sec" aria-labelledby="try-h">
          <div className="card pad24 land-try">
            <div className="grow stack g8">
              <div className="eyebrow">Try to drain it</div>
              <h2 id="try-h" className="land-h2" style={{ margin: 0 }}>Run the attacker yourself.</h2>
              <p className="t2">A scripted attacker with a stolen agent key tries to empty a sandbox vault. Watch the hot allowance go, the drain get held, and guardians rescue the rest. About 30 seconds, testnet only.</p>
            </div>
            <Link className="btn lg amb" to="/app/attack">Run attacker <ArrowRight className="ic" /></Link>
          </div>
        </section>

        <section id="threats" className="land-sec" aria-labelledby="threat-h">
          <div className="eyebrow">Threat model</div>
          <h2 id="threat-h" className="land-h2">What each attacker can and cannot do.</h2>
          <div className="card mt24">
            <dl className="threats">
              {THREATS.map(([k, v]) => (
                <div key={k} className="trow"><dt>{k}</dt><dd className="t2">{v}</dd></div>
              ))}
            </dl>
          </div>
          <p className="small t3 mt16">Honest scope: Rescue Room protects assets held by the vault. It cannot stop a key from spending funds held elsewhere. Not audited; testnet and Sepolia only.</p>
        </section>
      </main>
      <footer className="land-foot small t3">
        <span>Rescue Room · NEAR testnet</span>
        <span className="grow" />
        <Link className="link" to="/app/activity">Audit log</Link>
        <Link className="link" to="/app/policy">Policy</Link>
      </footer>
    </div>
  );
}
