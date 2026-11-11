import { Link } from 'react-router-dom';
import { ArrowRight, ArrowUpRight, ExternalLink, SquareTerminal } from 'lucide-react';
import { Mark, Ring } from '../components/Ring';
import { DEPLOY, useNow, useVaultData } from '../lib/useVault';
import { amt, acct, countdown, reqId, SIGNAL_LABEL, STATUS_LABEL, tierOf, time } from '../lib/format';
import type { Request, VaultStatus } from '../lib/types';

const SEPOLIA_RESCUE = '0xe7d3bd40c7bcc737ab0a8b9a088330356b2db918918a3888e55fad2c172275f7';
const NB = 'https://testnet.nearblocks.io';

const ATTACK = [
  { k: 'Allowance spent', d: 'A stolen agent key pays out 0.8 and 0.5 NEAR. Both fit the hot allowance, so the loss stops there.' },
  { k: 'Drain held', d: '2 NEAR to an unlisted address. The watcher scores it 75 for a chunked drain and a large share of reserve.', hot: true },
  { k: 'Guardians rescue', d: 'Two of three guardians vote. The vault freezes, the reserve goes to the safe address and the agent key is revoked.' },
  { k: 'Cover pays', d: 'The allowance loss is claimed from the cover pool and paid back to the treasury.' },
];

const STEPS = [
  { n: '01', t: 'Request', d: 'Every payment goes through the vault. Small ones inside the hot allowance pay at once.' },
  { n: '02', t: 'Score and hold', d: 'A watcher signs a risk score with its evidence. The score sets a timelock, never under the policy floor.' },
  { n: '03', t: 'Rescue or release', d: 'While the timelock runs, guardians can rescue the reserve. If nobody does, the payment goes out.' },
];

const PROOF = [
  { k: 'Rescue on Sepolia', v: 'Vault ETH sent to the safe address, signed by NEAR chain signatures', h: SEPOLIA_RESCUE, url: `https://sepolia.etherscan.io/tx/${SEPOLIA_RESCUE}`, net: 'Sepolia' },
  { k: 'Guardian rescue vote', v: 'Quorum reached on held request H-0020, which asked the MPC signer for that transfer', h: 'GZZE6t6gmWfh9STADw61Q44xiouAUeamfU2nCbFJVMk5', url: `${NB}/txns/GZZE6t6gmWfh9STADw61Q44xiouAUeamfU2nCbFJVMk5`, net: 'NEAR testnet' },
  { k: 'Held request', v: '0.01 ETH to an unknown address, held for guardians', h: 'FDWLMrZzjCKqWiLrNQweeCVYuC3gfw9vJEX1VxXvMn7k', url: `${NB}/txns/FDWLMrZzjCKqWiLrNQweeCVYuC3gfw9vJEX1VxXvMn7k`, net: 'NEAR testnet' },
  { k: 'Upgrade by DAO only', v: 'Vault v1.3.0 deployed through guardian DAO proposal 21', h: '5GhAF6V97TciXsXxfbeP8h9jav4HMUzao3w44TfFYz6M', url: `${NB}/txns/5GhAF6V97TciXsXxfbeP8h9jav4HMUzao3w44TfFYz6M`, net: 'NEAR testnet' },
];

const THREATS: [string, string][] = [
  ['Stolen agent key', 'Can only request. Loss is capped at the hot allowance'],
  ['Stolen owner key', 'Cannot change limits, guardians or the safe address'],
  ['Bad watcher', 'Unsigned scores are rejected. No score beats the floor'],
  ['Relayer', 'Only broadcasts a payload the MPC already fixed'],
  ['Deployer', 'The vault has no access keys. Upgrades need the DAO'],
];

const short = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;

/** Pick the request the hero shows: an open hold first, else the latest rescue, else the latest scored one. */
function pick(reqs: Request[]): Request | null {
  const scored = reqs.filter((r) => r.score && !r.hot).sort((a, b) => b.id - a.id);
  return scored.find((r) => r.status === 'Held') ?? scored.find((r) => r.status === 'Rescued') ?? scored[0] ?? null;
}

function HoldCard() {
  const { data } = useVaultData();
  const now = useNow(1000);
  const r = data ? pick(data.requests) : null;
  const st: VaultStatus | undefined = data?.status;
  if (!r || !r.score || !st) {
    return <div className="hcard hcard-empty" aria-busy="true"><span className="small t3">Reading the demo vault…</span></div>;
  }
  const held = r.status === 'Held';
  const start = Number(r.score.scored_at_ms), end = Number(r.release_ms);
  const left = Math.max(0, end - now);
  const frac = held ? Math.min(1, Math.max(0, (now - start) / Math.max(1, end - start))) : 1;
  const tier = tierOf(r.score.score);
  const tone = r.status === 'Rescued' ? 'green' : held ? 'amber' : 'muted';
  const sigs = [...r.score.signals].filter((s) => s.weight > 0).sort((a, b) => b.weight - a.weight).slice(0, 3);
  const need = st.approvals_needed;
  return (
    <article className="hcard" aria-label={`Latest hold ${reqId(r.id)}`}>
      <header className="hc-top">
        <span className={`tag ${held ? 'a' : r.status === 'Rescued' ? 'g' : ''}`}>{STATUS_LABEL[r.status]}</span>
        <span className="tag">{tier.label} risk</span>
        <span className="grow" />
        <span className="hc-live mono small t3"><span className="dot g" />{reqId(r.id)}</span>
      </header>
      <div className="hc-main">
        <Ring size={148} frac={frac} tone={tone} marker={held}>
          {held ? <><span className="fig sm">{countdown(left)}</span><span className="xs t3">left on hold</span></>
            : <><span className="hc-st">{STATUS_LABEL[r.status]}</span><span className="xs t3">{time(r.release_ms)} WAT</span></>}
        </Ring>
        <div className="hc-fig">
          <span className="fig">{amt(r.asset, r.amount)}</span>
          <span className="small t2 mono hc-to">to {r.to.startsWith('0x') ? short(r.to) : acct(r.to)}</span>
          <span className="hc-score"><span className="mono amber">{r.score.score}</span><span className="small t3">/100 risk</span></span>
        </div>
      </div>
      <ul className="hc-sigs">
        {sigs.map((s) => (
          <li key={s.code}>
            <span className="small">{SIGNAL_LABEL[s.code] ?? s.code}</span>
            <span className="hc-bar" aria-hidden><i style={{ width: `${Math.min(100, (s.weight / 40) * 100)}%` }} /></span>
            <span className="mono small amber">+{s.weight}</span>
          </li>
        ))}
      </ul>
      <div className="hc-votes">
        <div className="row"><span className="small t2">Guardian votes</span><span className="grow" /><span className="mono small">{r.approvals.length} of {need}</span></div>
        <div className="hc-pips" aria-hidden>{Array.from({ length: need }, (_, i) => <i key={i} className={i < r.approvals.length ? 'on' : ''} />)}</div>
        <ul>
          {st.guardians.map((g) => (
            <li key={g} className="small"><span className="mono t2 hc-g" title={g}>{g}</span><span className="grow" /><span className="t3">{r.approvals.includes(g) ? 'voted rescue' : 'no vote'}</span></li>
          ))}
        </ul>
      </div>
      <Link className="btn amb full" to={`/app/holds/${r.id}`}>{held ? 'Vote to rescue' : 'Open this hold'}<ArrowRight className="ic" /></Link>
    </article>
  );
}

export function Landing() {
  return (
    <div className="land">
      <header className="land-top">
        <Link to="/" className="brand" style={{ padding: 0 }}><Mark />Rescue Room</Link>
        <span className="grow" />
        <nav className="land-nav small" aria-label="Sections">
          <a href="#attack">Attack</a>
          <a href="#how">How it works</a>
          <a href="#proof">Proof</a>
          <a href="#threats">Threat model</a>
        </nav>
        <Link className="btn sm land-open" to="/app" aria-label="Open the demo vault"><span className="lbl-d">Open demo vault</span><ArrowUpRight className="ic" /></Link>
      </header>

      <main id="main">
        <section className="land-hero">
          <div className="lh-copy">
            <h1 className="land-h1">Attackers can fool the agent. They can’t drain the vault.</h1>
            <p className="land-lead">Everyday payments go straight through. Anything unusual waits on a timelock, with a plain reason, while guardians decide whether to rescue the funds.</p>
            <div className="lh-cta">
              <Link className="btn lg amb" to="/app/attack"><SquareTerminal className="ic" />Try to drain it</Link>
              <Link className="btn lg ghost" to="/app">Open the demo vault<ArrowRight className="ic" /></Link>
            </div>
          </div>
          <div className="lh-vis">
            <HoldCard />
            <p className="xs t3 lh-cap">Latest hold on the demo vault, read live from NEAR testnet</p>
          </div>
        </section>

        <section id="attack" className="land-sec" aria-labelledby="attack-h">
          <h2 id="attack-h" className="land-h2">What happens in an attack</h2>
          <ol className="tl">
            {ATTACK.map((s, i) => (
              <li key={s.k} className={s.hot ? 'hot' : ''}>
                <span className="tl-n mono">{String(i + 1).padStart(2, '0')}</span>
                <h3 className="h3">{s.k}</h3>
                <p className="small t2">{s.d}</p>
              </li>
            ))}
          </ol>
        </section>

        <section id="how" className="land-sec" aria-labelledby="how-h">
          <h2 id="how-h" className="land-h2">How it works</h2>
          <ol className="steps">
            {STEPS.map((s) => (
              <li key={s.n}><span className="mono amber small">{s.n}</span><h3 className="h3">{s.t}</h3><p className="small t2">{s.d}</p></li>
            ))}
          </ol>
        </section>

        <section id="proof" className="land-sec" aria-labelledby="proof-h">
          <h2 id="proof-h" className="land-h2">Proof on chain</h2>
          <ul className="proof">
            {PROOF.map((p) => (
              <li key={p.h}>
                <a href={p.url} target="_blank" rel="noreferrer">
                  <span className="pf-k">{p.k}</span>
                  <span className="pf-v small t2">{p.v}</span>
                  <span className="pf-h mono small t3">{p.net} · {short(p.h)}<ExternalLink className="ic" aria-hidden /></span>
                </a>
              </li>
            ))}
          </ul>
          <p className="xs t3 mt16">NEAR testnet and Ethereum Sepolia only. Vault <a className="link" href={`${NB}/address/${DEPLOY.vault}`} target="_blank" rel="noreferrer">{DEPLOY.vault}</a>. ETH is signed through v1.signer-prod.testnet.</p>
        </section>

        <section className="land-sec" aria-labelledby="try-h">
          <div className="try">
            <div>
              <h2 id="try-h" className="land-h2">Try to drain it</h2>
              <p className="t2 mt8">Run a scripted attacker with a stolen agent key against a sandbox vault. Takes about 30 seconds</p>
            </div>
            <Link className="btn lg amb" to="/app/attack">Run the attacker<ArrowRight className="ic" /></Link>
          </div>
        </section>

        <section id="threats" className="land-sec" aria-labelledby="threat-h">
          <h2 id="threat-h" className="land-h2">Threat model</h2>
          <dl className="threats">
            {THREATS.map(([k, v]) => (<div key={k}><dt className="small">{k}</dt><dd className="small t2">{v}</dd></div>))}
          </dl>
          <p className="xs t3 mt16">Protects assets held by the vault, not funds a key controls elsewhere. Not audited.</p>
        </section>
      </main>

      <footer className="land-foot">
        <span className="brand small" style={{ padding: 0 }}><Mark size={18} />Rescue Room</span>
        <span className="xs t3">NEAR testnet · Ethereum Sepolia via chain signatures</span>
        <span className="grow" />
        <nav className="row gap16 small" aria-label="Footer">
          <Link className="t2" to="/app">Dashboard</Link>
          <Link className="t2" to="/app/attack">Attack sandbox</Link>
          <Link className="t2" to="/app/activity">Audit log</Link>
          <Link className="t2" to="/app/policy">Policy</Link>
        </nav>
      </footer>
    </div>
  );
}
