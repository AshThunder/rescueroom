import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useVault } from '../components/Shell';
import { Card, Empty, ErrorState, Skeleton, PageHeader } from '../components/ui';
import { RiskTag, StatusTag, describe, who } from '../components/vault';
import { isOpen, useNow } from '../lib/useVault';
import { acct, amt, countdown, dateTime, reqId, short } from '../lib/format';

const FILTERS = [
  ['open', 'Open'],
  ['resolved', 'Resolved'],
  ['all', 'All'],
] as const;

export function Holds() {
  const { data, error, loading, refresh } = useVault();
  const [f, setF] = useState<(typeof FILTERS)[number][0]>('open');
  const nav = useNavigate();
  const now = useNow();
  const rows = (data?.requests ?? []).filter((r) => (f === 'all' ? true : f === 'open' ? isOpen(r) : !isOpen(r)));
  return (
    <>
      <PageHeader title="Holds" sub={<>Every withdrawal beyond the hot allowance waits here until its hold ends, the owner cancels it, or guardians rescue.</>} actions={<><div className="seg" role="group" aria-label="Filter"> {FILTERS.map(([k, l]) => ( <button key={k} aria-pressed={f === k} onClick={() => setF(k)}>{l}</button> ))} </div></>} />
      <Card className="mt24">
        {loading && !data ? (
          <div className="pad stack g12">{[0, 1, 2].map((i) => <Skeleton key={i} h={20} />)}</div>
        ) : !data ? (
          <ErrorState error={error || 'unknown'} onRetry={refresh} />
        ) : rows.length === 0 ? (
          <Empty title={f === 'open' ? 'Nothing on hold' : 'No requests'}>{f === 'open' ? 'Withdrawals within the hot allowance go straight through.' : 'Requests will appear once the vault is used.'}</Empty>
        ) : (
          <div className="tblwrap">
            <table className="tbl resp">
              <thead>
                <tr><th>Request</th><th className="num">Amount</th><th>Requested by</th><th>Created (WAT)</th><th className="num">Hold left</th><th className="r">Risk and status</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const left = Number(r.release_ms) - now;
                  return (
                    <tr key={r.id} className="click" onClick={() => nav(`/app/holds/${r.id}`)} tabIndex={0} aria-label={`${reqId(r.id)}: ${describe(r)}, ${r.status}`} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), nav(`/app/holds/${r.id}`))}>
                      <td className="c-main"><span className="mono t3">{reqId(r.id)}</span> to {r.asset === 'Near' ? acct(r.to) : short(r.to, 6, 4)}{r.memo && <span className="sub ellip" style={{ maxWidth: 280 }}>{r.memo}</span>}</td>
                      <td className="num c-aside">{amt(r.asset, r.amount)}</td>
                      <td className="small t2 c-meta" data-label="By">{who(r)}</td>
                      <td className="small t3 nowrap c-meta">{dateTime(r.created_ms)}</td>
                      <td className="num small c-meta" data-label="Hold">{isOpen(r) ? (left > 0 ? <span className="amber">{countdown(left)}</span> : <span className="green">ready</span>) : <span className="t3">none</span>}</td>
                      <td className="r c-tags"><div className="cell-tags"><RiskTag r={r} /><StatusTag r={r} /></div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
