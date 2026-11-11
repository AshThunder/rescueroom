import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Lock, Plus, ShieldAlert, SlidersHorizontal, SquareTerminal, Wallet, Zap } from 'lucide-react';
import { useVault } from '../components/Shell';
import { Bar, Card, Empty, ErrorState, LoadingCards, Tag, PageHeader } from '../components/ui';
import { Ring } from '../components/Ring';
import { RiskTag, StatusTag, describe, who } from '../components/vault';
import { DEPLOY, isOpen, useNow } from '../lib/useVault';
import { acct, amt, countdown, duration, ethAmt, nearAmt, reqId, short, time } from '../lib/format';

export function Overview() {
  const { data, error, loading, refresh } = useVault();
  const now = useNow();
  const nav = useNavigate();
  if (loading && !data) return <><Header /><div className="mt24"><LoadingCards /></div></>;
  if (!data) return <><Header /><div className="card mt24"><ErrorState error={error || 'unknown error'} onRetry={refresh} /></div></>;
  const { config: c, status: s, cover, requests } = data;
  const open = requests.filter(isOpen).sort((a, b) => (b.score?.score ?? 101) - (a.score?.score ?? 101));
  const top = open[0];
  const nearLimit = BigInt(c.near_allowance.limit), ethLimit = BigInt(c.eth_allowance.limit);
  const nearLeft = BigInt(s.near_hot_remaining), ethLeft = BigInt(s.eth_hot_remaining);
  const heldNear = open.filter((r) => r.asset === 'Near').reduce((t, r) => t + BigInt(r.amount), 0n);
  const heldEth = open.filter((r) => r.asset === 'SepoliaEth').reduce((t, r) => t + BigInt(r.amount), 0n);
  const solv = cover.solvency_bps >= 4294967295 ? null : cover.solvency_bps / 10000;
  const div = c.demo_time_divisor;
  return (
    <>
      <Header sub={<>Guarded by <span className="mono">{c.guardian_dao}</span> · {s.guardians.length} guardians · {s.approvals_needed} to rescue</>} />
      {error && <div className="banner r mt16 small" role="alert">Live refresh failed: {error}. Showing data from {time(data.updatedAt)} WAT.</div>}
      {s.frozen && (
        <div className="banner r mt24" role="status">
          <ShieldAlert className="ic lg red" aria-hidden />
          <div className="grow">
            <div className="h3">Vault frozen after a rescue</div>
            <div className="small t2">New withdrawals are blocked until the guardian DAO passes an unfreeze proposal.</div>
          </div>
        </div>
      )}
      {requests.length === 0 && <FirstRun />}
      {top && (
        <div className="banner a mt24">
          <Ring size={56} ticks={36} marker={false} frac={progress(top, now)} />
          <div className="grow" style={{ minWidth: 200 }}>
            <div className="h3">{top.status === 'PendingScore' ? 'Awaiting score' : 'Held'}: {describe(top)}{top.agent ? ` via agent key “${top.agent}”` : ''}</div>
            <div className="small t2 mono">
              {reqId(top.id)} · {top.score ? `risk ${top.score.score}` : 'unscored'} · {Number(top.release_ms) > now ? `${countdown(Number(top.release_ms) - now)} left` : 'hold over'} · {top.approvals.length} of {s.approvals_needed} guardian votes
            </div>
          </div>
          <button className="btn amb" onClick={() => nav(`/app/holds/${top.id}`)}>Review hold <ArrowRight className="ic" /></button>
        </div>
      )}
      <div className="grid g3 mt24">
        <Card title="Hot allowance" aside={<Tag><Zap className="ic" style={{ width: 12, height: 12 }} />instant</Tag>}>
          <div className="pad stack g16">
            <div className="small t3" style={{ marginTop: -8 }}>No delay up to the limit per {duration(c.near_allowance.window_secs / div)} window</div>
            <div className="stack g8">
              <div className="row sp"><span className="lbl">NEAR</span><span className="mono">{nearAmt(nearLeft)} <span className="t3">/ {nearAmt(nearLimit)} left</span></span></div>
              <Bar frac={Number(nearLeft) / Number(nearLimit || 1n)} />
            </div>
            <div className="stack g8">
              <div className="row sp"><span className="lbl">Sepolia ETH</span><span className="mono">{ethAmt(ethLeft)} <span className="t3">/ {ethAmt(ethLimit)} left</span></span></div>
              <Bar frac={Number(ethLeft) / Number(ethLimit || 1n)} tone="var(--amber)" />
            </div>
          </div>
        </Card>
        <Card title="Cold reserve" aside={<Tag><Lock className="ic" style={{ width: 12, height: 12 }} />timelocked</Tag>}>
          <div className="pad">
            <div className="grid g2" style={{ gap: 16 }}>
              <div className="stack g4">
                <span className="lbl">NEAR</span>
                <span className="fig">{nearAmt(s.near_available)}</span>
                <span className="small t3">{heldNear ? <span className="amber">{nearAmt(heldNear)} held</span> : '0 held'}</span>
              </div>
              <div className="stack g4">
                <span className="lbl">Sepolia ETH</span>
                <span className="fig">{data.ethBalance === null ? '—' : ethAmt(data.ethBalance)}</span>
                <span className="small t3">{heldEth ? <span className="amber">{ethAmt(heldEth)} held</span> : '0 held'}</span>
              </div>
            </div>
            <div className="small t3 mt16">Sepolia funds sit at <a className="link mono" href={`https://sepolia.etherscan.io/address/${DEPLOY.vault_sepolia_address}`} target="_blank" rel="noreferrer">{short(DEPLOY.vault_sepolia_address)}</a>, signed by NEAR chain signatures</div>
          </div>
        </Card>
        <Card title="Cover pool" aside={solv === null ? <Tag>no exposure</Tag> : <Tag tone={solv >= 1 ? 'g' : 'r'} dot>{solv >= 1 ? 'solvent' : 'under-reserved'}</Tag>}>
          <div className="pad stack g12">
            <div className="row gap8" style={{ alignItems: 'baseline' }}>
              <span className="fig">{solv === null ? '—' : `${solv.toFixed(2)}×`}</span>
              <span className="small t3">liquid to max exposure</span>
            </div>
            <div className="small t2 mono">{nearAmt(cover.pool_balance)} NEAR liquid · {nearAmt(cover.active_exposure)} NEAR exposure</div>
            <Bar frac={solv === null ? 0 : Math.min(1, 1 / Math.max(solv, 0.0001))} />
            <div className="row sp small t3"><span>Premium now {(cover.premium_bps / 100).toFixed(2)}% / 30d</span><Link className="link" to="/app/cover">Open pool</Link></div>
          </div>
        </Card>
      </div>
      <div className="split wide mt16">
        <Card title="Recent requests" aside={<><span className="dot g" />Live from testnet</>}>
          {requests.length === 0 ? (
            <Empty title="No requests yet">Withdrawals made through the vault appear here.</Empty>
          ) : (
            <div className="tblwrap">
              <table className="tbl resp">
                <thead><tr><th>Request</th><th className="num">Amount</th><th className="r">Risk and status</th><th>Created (WAT)</th></tr></thead>
                <tbody>
                  {requests.slice(0, 10).map((r) => (
                    <tr key={r.id} className="click" tabIndex={0} aria-label={`${reqId(r.id)}: ${describe(r)}, ${r.status}`} onClick={() => nav(`/app/holds/${r.id}`)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), nav(`/app/holds/${r.id}`))}>
                      <td className="c-main"><span className="mono t3">{reqId(r.id)}</span> <span>to {r.asset === 'Near' ? acct(r.to) : short(r.to, 6, 4)}</span><span className="sub ellip">{who(r)}</span></td>
                      <td className="num c-aside">{amt(r.asset, r.amount)}</td>
                      <td className="r c-tags"><div className="cell-tags"><RiskTag r={r} /><StatusTag r={r} /></div></td>
                      <td className="mono t3 nowrap c-meta">{time(r.created_ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="Policy" aside={<Link className="link" to="/app/policy">Details</Link>}>
          <dl>
            {c.hold_tiers.map((t, i) => {
              const next = c.hold_tiers[i + 1];
              const hold = Math.max(t.hold_secs, c.hold_floor_secs);
              return (
                <div className="kv" key={t.min_score}>
                  <dt>Risk {t.min_score}–{next ? next.min_score - 1 : 100}</dt>
                  <dd className={i === c.hold_tiers.length - 1 ? 'amber' : ''}>{hold ? `${duration(hold)} hold` : 'Instant if within allowance'}{div > 1 && hold ? <span className="t3 small"> · demo {duration(hold / div)}</span> : ''}</dd>
                </div>
              );
            })}
            <div className="kv"><dt>Guardians</dt><dd>{s.guardians.length} · {c.quorum_pct}% quorum · ≥{c.min_distinct} distinct</dd></div>
            <div className="kv"><dt>Safe address</dt><dd className="mono small">{c.safe_near}</dd></div>
          </dl>
        </Card>
      </div>
    </>
  );
}

function FirstRun() {
  return (
    <Card className="mt24" title="Get started" aside="New vault">
      <ol className="steps pad">
        <li><span className="n">01</span><span className="h3">Connect a wallet</span><span className="small t2">The owner, a guardian or anyone can connect MyNearWallet, Meteor or HERE on testnet.</span><Link className="link small" to="/app/sign/request/new"><Wallet className="ic" style={{ width: 12, height: 12, verticalAlign: -1 }} /> Open signing page</Link></li>
        <li><span className="n">02</span><span className="h3">Make a first withdrawal</span><span className="small t2">Small amounts pay instantly from the hot allowance. Anything larger is scored and held.</span><Link className="link small" to="/app/sign/request/new">New withdrawal</Link></li>
        <li><span className="n">03</span><span className="h3">Try to drain it</span><span className="small t2">Run the scripted attacker against the sandbox vault and watch the guardians rescue the reserve.</span><Link className="link small" to="/app/attack"><SquareTerminal className="ic" style={{ width: 12, height: 12, verticalAlign: -1 }} /> Run attacker</Link></li>
      </ol>
    </Card>
  );
}

function progress(r: { created_ms: string; release_ms: string }, now: number) {
  const a = Number(r.created_ms), b = Number(r.release_ms);
  if (b <= a) return 1;
  return Math.min(1, (now - a) / (b - a));
}

function Header({ sub }: { sub?: React.ReactNode }) {
  return (
    <PageHeader
      title="Demo treasury"
      sub={sub || '\u00a0'}
      actions={<>
        <Link className="btn" to="/app/policy"><SlidersHorizontal className="ic" />Policy</Link>
        <Link className="btn pri" to="/app/sign/request/new"><Plus className="ic" />New withdrawal</Link>
      </>}
    />
  );
}
