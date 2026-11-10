import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useVault } from '../components/Shell';
import { Bar, Card, Empty, ErrorState, Kv, LoadingCards, Tag } from '../components/ui';
import { DEPLOY } from '../lib/useVault';
import { view } from '../lib/near';
import { acct, dateTime, nearAmt } from '../lib/format';

const YOCTO = 10n ** 24n;

function parseNear(s: string): bigint | null {
  if (!/^\d+(\.\d{0,6})?$/.test(s.trim())) return null;
  const [w, f = ''] = s.trim().split('.');
  return BigInt(w) * YOCTO + BigInt((f + '000000').slice(0, 6)) * 10n ** 18n;
}

export function Cover() {
  const { data, error, loading, refresh } = useVault();
  const [amount, setAmount] = useState('1');
  const [quote, setQuote] = useState<{ v: string | null; err: string | null; busy: boolean }>({ v: null, err: null, busy: false });
  const y = parseNear(amount);
  useEffect(() => {
    if (y === null || y === 0n) return;
    setQuote((q) => ({ ...q, busy: true }));
    const t = setTimeout(() => {
      view<string>(DEPLOY.vault, 'quote_premium', { coverage: y.toString() })
        .then((v) => setQuote({ v, err: null, busy: false }))
        .catch((e) => setQuote({ v: null, err: e.message, busy: false }));
    }, 300);
    return () => clearTimeout(t);
  }, [amount]);

  if (loading && !data) return <LoadingCards />;
  if (!data) return <Card><ErrorState error={error || 'unknown'} onRetry={refresh} /></Card>;
  const { cover: s, policies, claims } = data;
  const solv = s.solvency_bps >= 4294967295 ? null : s.solvency_bps / 10000;
  const invalid = amount !== '' && (y === null || y === 0n);
  return (
    <>
      <div className="phead">
        <div>
          <h1 className="ptitle">Cover pool</h1>
          <p className="psub">Holds protect the cold reserve. Cover backs what holds cannot stop: losses inside the hot allowance.</p>
        </div>
      </div>
      <div className="grid g3 mt24">
        <Card title="Solvency" aside={solv === null ? <Tag>no exposure</Tag> : <Tag tone={solv >= 1 ? 'g' : 'r'} dot>{solv >= 1 ? 'solvent' : 'under-reserved'}</Tag>}>
          <div className="pad stack g8">
            <span className="fig">{solv === null ? '—' : `${solv.toFixed(2)}×`}</span>
            <span className="small t3">pool ÷ active exposure (each policy counted up to the per-incident cap)</span>
          </div>
        </Card>
        <Card title="Pool">
          <div className="pad stack g8">
            <span className="fig">{nearAmt(s.pool_balance)}<span className="u">NEAR</span></span>
            <span className="small t3">{nearAmt(s.active_exposure)} NEAR exposure · {s.active_policies} active {s.active_policies === 1 ? 'policy' : 'policies'}</span>
          </div>
        </Card>
        <Card title="Risk price">
          <div className="pad stack g8">
            <span className="fig">{(s.premium_bps / 100).toFixed(2)}<span className="u">% / 30 days</span></span>
            <Bar frac={s.risk_points / 100} tone="var(--amber)" />
            <span className="small t3">{s.risk_points} risk points from guardian count, holds, recent scores and past rescues</span>
          </div>
        </Card>
      </div>
      <div className="split mt16">
        <div className="stack g16">
          <Card title="Policies">
            {policies.length === 0 ? <Empty title="No policies yet" /> : (
              <div className="tblwrap"><table className="tbl resp">
                <thead><tr><th>Policy</th><th className="num">Coverage</th><th className="num">Premium</th><th className="num">Paid out</th><th>Ends (WAT)</th></tr></thead>
                <tbody>{policies.map((p) => (
                  <tr key={p.id}><td className="c-main"><span className="mono t3">#{p.id}</span> <span className="mono small" title={p.holder}>{acct(p.holder)}</span></td><td className="num c-aside">{nearAmt(p.coverage)} NEAR</td><td className="num c-meta" data-label="Premium">{nearAmt(p.premium, 4)}</td><td className="num c-meta" data-label="Paid">{nearAmt(p.paid_out)}</td><td className="small t3 nowrap c-meta">{dateTime(p.end_ms)}</td></tr>
                ))}</tbody>
              </table></div>
            )}
          </Card>
          <Card title="Claims" aside={<Link className="link" to="/app/sign/fileclaim/new">File a claim</Link>}>
            {claims.length === 0 ? <Empty title="No claims">Claims are approved by the same guardian quorum, then paid from the pool.</Empty> : (
              <div className="tblwrap"><table className="tbl resp">
                <thead><tr><th>Claim</th><th className="num">Asked</th><th className="num">Paid</th><th className="r">Status</th></tr></thead>
                <tbody>{claims.map((c) => (
                  <tr key={c.id}><td className="c-main"><span className="mono t3">#{c.id}</span> <span className="small">{c.reason}</span></td><td className="num c-aside">{nearAmt(c.amount)} NEAR</td><td className="num c-meta" data-label="Paid">{nearAmt(c.payout)}</td><td className="r c-tags"><div className="cell-tags">{c.status === 'Pending' ? <Link className="btn sm" to={`/app/sign/claim/${c.id}`}>Review</Link> : null}<Tag tone={c.status === 'Paid' ? 'g' : c.status === 'Rejected' ? 'r' : 'a'}>{c.status}</Tag></div></td></tr>
                ))}</tbody>
              </table></div>
            )}
          </Card>
        </div>
        <Card title="Quote cover">
          <form className="pad stack g16" onSubmit={(e) => e.preventDefault()}>
            <div className="field">
              <label htmlFor="cov">Coverage (NEAR)</label>
              <input id="cov" className="input mono" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={invalid} aria-describedby="cov-hint" />
              <span id="cov-hint" className={`hint ${invalid ? 'red' : ''}`}>{invalid ? 'Enter a positive amount, up to 6 decimals.' : `Payout per incident is capped at ${nearAmt(s.per_incident_cap)} NEAR.`}</span>
            </div>
            <dl className="card" style={{ background: 'var(--bg0)' }}>
              <Kv tight k="Premium">{quote.busy ? <span className="t3">pricing…</span> : quote.err ? <span className="red small">{quote.err}</span> : quote.v && !invalid ? <span className="mono nowrap">{nearAmt(quote.v, 4)} NEAR</span> : '—'}</Kv>
              <Kv tight k="Term">30 days</Kv>
            </dl>
            <Link className="btn pri full" to={`/app/sign/cover/${y && !invalid ? y.toString() : 0}`}>Buy cover</Link>
            <p className="small t3">Quote is computed by the contract's <span className="mono">quote_premium</span> view, live.</p>
          </form>
        </Card>
      </div>
    </>
  );
}
