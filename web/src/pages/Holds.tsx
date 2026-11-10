import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useVault } from '../components/Shell';
import { Card, Empty, ErrorState, Skeleton } from '../components/ui';
import { RiskTag, StatusTag, describe, who } from '../components/vault';
import { isOpen, useNow } from '../lib/useVault';
import { countdown, dateTime, reqId } from '../lib/format';

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
      <div className="phead">
        <div>
          <h1 className="ptitle">Holds</h1>
          <p className="psub">Every withdrawal beyond the hot allowance waits here until its hold ends, the owner cancels it, or guardians rescue.</p>
        </div>
        <div className="seg" role="group" aria-label="Filter">
          {FILTERS.map(([k, l]) => (
            <button key={k} aria-pressed={f === k} onClick={() => setF(k)}>{l}</button>
          ))}
        </div>
      </div>
      <Card className="mt24">
        {loading && !data ? (
          <div className="pad stack g12">{[0, 1, 2].map((i) => <Skeleton key={i} h={20} />)}</div>
        ) : !data ? (
          <ErrorState error={error || 'unknown'} onRetry={refresh} />
        ) : rows.length === 0 ? (
          <Empty title={f === 'open' ? 'Nothing on hold' : 'No requests'}>{f === 'open' ? 'Withdrawals within the hot allowance go straight through.' : 'Requests will appear once the vault is used.'}</Empty>
        ) : (
          <div className="tblwrap">
            <table className="tbl">
              <thead>
                <tr><th>ID</th><th>Request</th><th>Requested by</th><th>Created</th><th>Hold</th><th className="r">Risk · status</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const left = Number(r.release_ms) - now;
                  return (
                    <tr key={r.id} className="click" onClick={() => nav(`/app/holds/${r.id}`)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && nav(`/app/holds/${r.id}`)}>
                      <td className="mono t2 nowrap">{reqId(r.id)}</td>
                      <td><div className="ellip" style={{ maxWidth: 320 }}>{describe(r)}</div>{r.memo && <div className="small t3 ellip" style={{ maxWidth: 320 }}>{r.memo}</div>}</td>
                      <td className="small t2">{who(r)}</td>
                      <td className="small t3 nowrap">{dateTime(r.created_ms)}</td>
                      <td className="mono small nowrap">{isOpen(r) ? (left > 0 ? <span className="amber">{countdown(left)}</span> : <span className="green">ready</span>) : <span className="t3">—</span>}</td>
                      <td className="r"><div className="row gap8" style={{ justifyContent: 'flex-end' }}><RiskTag r={r} /><StatusTag r={r} /></div></td>
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
