import { Link } from 'react-router-dom';
import { useVault } from '../components/Shell';
import { Card, ErrorState, ExtLink, Kv, LoadingCards, Tag, PageHeader } from '../components/ui';
import { nearblocksAcct } from '../lib/near';

export function Guardians() {
  const { data, error, loading, refresh } = useVault();
  if (loading && !data) return <LoadingCards n={2} />;
  if (!data) return <Card><ErrorState error={error || 'unknown'} onRetry={refresh} /></Card>;
  const { config: c, status: s, requests, claims } = data;
  const votes = (g: string) => requests.filter((r) => r.approvals.includes(g)).length + claims.filter((x) => x.approvals.includes(g)).length;
  return (
    <>
      <PageHeader title="Guardians" sub={<>Members of the <span className="mono">{c.guardian_role}</span> role in the vault's Sputnik DAO. No staking, no slashing.</>} actions={<><Link className="btn" to="/app/sign/unfreeze/0">Propose unfreeze</Link></>} />
      <div className="split wide mt24">
        <Card title="Council" aside={<span className="mono">{s.guardians.length} members</span>}>
          <div className="tblwrap">
            <table className="tbl resp">
              <thead><tr><th>Account</th><th className="num">Votes cast</th><th className="r">Role</th></tr></thead>
              <tbody>
                {s.guardians.map((g) => (
                  <tr key={g}>
                    <td className="c-main"><div className="row gap12"><span className="avatar" aria-hidden>{g.slice(0, 2).toUpperCase()}</span><ExtLink href={nearblocksAcct(g)}><span className="mono small">{g}</span></ExtLink></div></td>
                    <td className="num c-meta" data-label="Votes cast">{votes(g)}</td>
                    <td className="r c-aside"><Tag>{c.guardian_role}</Tag></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card title="Rescue rule">
          <dl>
            <Kv k="DAO"><ExtLink href={nearblocksAcct(c.guardian_dao)}><span className="mono small">{c.guardian_dao}</span></ExtLink></Kv>
            <Kv k="Quorum">{c.quorum_pct}% of the council</Kv>
            <Kv k="Distinct floor">at least {c.min_distinct} different guardians</Kv>
            <Kv k="Needed now"><span className="mono">{s.approvals_needed}</span> approvals</Kv>
            <Kv k="Two paths">Guardians vote on the vault directly, or the DAO passes a FunctionCall proposal to <span className="mono">dao_rescue</span>.</Kv>
            <Kv k="Sync"><span className="mono small">sync_guardians</span> reads the DAO policy on-chain, so membership changes stay in the DAO.</Kv>
          </dl>
        </Card>
      </div>
    </>
  );
}
