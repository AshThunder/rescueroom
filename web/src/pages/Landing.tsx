import { Link } from 'react-router-dom';
import { ArrowRight, Hourglass, LifeBuoy, Umbrella } from 'lucide-react';
import { Mark, Ring } from '../components/Ring';

const POINTS = [
  { icon: Hourglass, t: 'Risk-scored holds', d: 'Small spends go through instantly. Anything bigger waits for a watcher score, from no hold up to six hours.' },
  { icon: LifeBuoy, t: 'Guardian rescue', d: 'Your Sputnik DAO council can block a drain and move funds to a pre-set safe address. The owner can cancel any of their own holds instantly.' },
  { icon: Umbrella, t: 'Cover for the rest', d: 'A small pool prices premiums by risk, caps each payout and shows its solvency live.' },
];

export function Landing() {
  return (
    <div style={{ background: 'var(--bg0)', minHeight: '100vh' }}>
      <header className="row gap16" style={{ height: 64, padding: '0 var(--s10)', borderBottom: '1px solid var(--line)' }}>
        <div className="brand" style={{ padding: 0 }}><Mark />Rescue Room</div>
        <span className="grow" />
        <a className="t2 hide-m" href="#how">How it works</a>
        <Link className="btn sm pri" to="/app">Open the demo vault</Link>
      </header>
      <main id="main">
        <section className="split" style={{ maxWidth: 1200, margin: '0 auto', padding: '80px var(--s10)', gridTemplateColumns: 'minmax(0,1fr) 360px', gap: 64, alignItems: 'center' }}>
          <div>
            <span className="tag a">NEAR testnet · Sepolia via chain signatures</span>
            <h1 style={{ fontSize: 52, lineHeight: '56px', fontWeight: 400, letterSpacing: '-.03em', marginTop: 24 }}>A hold-and-rescue layer for treasuries and AI agents.</h1>
            <p className="t2" style={{ fontSize: 18, lineHeight: '28px', marginTop: 24, maxWidth: '34rem' }}>
              Rescue Room sits between a vault and whoever holds its keys. When a stolen key or a confused agent starts moving money, the vault holds it, explains why, and lets your guardians step in.
            </p>
            <div className="row gap12 mt32 wrap">
              <Link className="btn lg amb" to="/app">See the live vault <ArrowRight className="ic" /></Link>
              <Link className="btn lg" to="/app/attack">Watch it get attacked</Link>
            </div>
          </div>
          <div className="card pad24 stack g16" style={{ alignItems: 'center' }}>
            <Ring size={240} frac={0.38}>
              <span className="fig" style={{ fontSize: 34, lineHeight: '40px' }}>3h 42m</span>
              <span className="small t3">left of 6h hold</span>
            </Ring>
            <div className="small t2" style={{ textAlign: 'center' }}>2 NEAR to a wallet this vault has never paid. Risk 100. Two of three guardians needed.</div>
          </div>
        </section>
        <section id="how" style={{ maxWidth: 1200, margin: '0 auto', padding: '0 var(--s10) 96px' }}>
          <div className="grid g3">
            {POINTS.map((p) => (
              <div key={p.t} className="card pad24 stack g12">
                <p.icon className="ic lg amber" aria-hidden />
                <h2 className="h3">{p.t}</h2>
                <p className="t2 cap">{p.d}</p>
              </div>
            ))}
          </div>
          <p className="small t3 mt24">Honest scope: Rescue Room protects assets held by the vault. It cannot stop a key from spending funds held elsewhere.</p>
        </section>
      </main>
    </div>
  );
}
