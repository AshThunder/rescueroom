import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { useVault } from '../components/Shell';
import { Card, Empty, ErrorState, Skeleton, Tag, PageHeader } from '../components/ui';
import { api, type IndexedEvent } from '../lib/api';
import { describeEvent, type Group } from '../lib/events';
import { acct, dateTime, reqId } from '../lib/format';
import { useActiveVault } from '../lib/active';
import { PatternAlerts } from '../components/Patterns';

const FILTERS: { key: Group | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'requests', label: 'Requests' },
  { key: 'guardians', label: 'Guardians' },
  { key: 'cover', label: 'Cover' },
  { key: 'admin', label: 'Admin' },
];

export function Activity() {
  useVault();
  const vault = useActiveVault();
  const [events, setEvents] = useState<IndexedEvent[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sync, setSync] = useState<number | null>(null);
  const [f, setF] = useState<Group | 'all'>('all');
  const load = useCallback(() => {
    api<{ events: IndexedEvent[]; last_sync: number }>(`/events?account=${encodeURIComponent(vault)}&limit=500`)
      .then((r) => {
        setEvents(r.events);
        setSync(r.last_sync);
        setErr(null);
      })
      .catch((e) => setErr(e.message));
  }, [vault]);
  useEffect(() => {
    load();
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, [load]);
  const rows = (events || []).map((e) => ({ e, d: describeEvent(e) })).filter((x) => f === 'all' || x.d.group === f);
  return (
    <>
      <PageHeader title="Audit log" sub={<>NEP-297 events emitted by <span className="mono">{vault}</span> (<span className="mono">standard: rescueroom</span>), indexed from NEAR testnet.</>} actions={<><div className="seg" role="group" aria-label="Filter events"> {FILTERS.map((x) => <button key={x.key} aria-pressed={f === x.key} onClick={() => setF(x.key)}>{x.label}</button>)} </div></>} />
      <PatternAlerts />
      <Card className="mt24" title="Events" aside={<>{sync ? <>synced {dateTime(sync)}</> : null}<button className="btn ghost sm" onClick={load} aria-label="Refresh events"><RefreshCw className="ic" /></button></>}>
        {err && !events ? (
          <ErrorState error={`Event indexer unavailable (${err}). Start it with: npm run api`} onRetry={load} />
        ) : !events ? (
          <div className="pad stack g12" aria-busy="true">{[0, 1, 2, 3].map((i) => <Skeleton key={i} h={20} />)}</div>
        ) : rows.length === 0 ? (
          <Empty title="No events yet">{f === 'all' ? 'Contract events appear here a few seconds after each transaction.' : 'Nothing in this group yet.'}</Empty>
        ) : (
          <div className="tblwrap">
            <table className="tbl resp">
              <thead><tr><th>Event</th><th>Signed by</th><th>Time (WAT)</th><th className="num c-opt">Block</th><th className="r">Explorer</th></tr></thead>
              <tbody>
                {rows.map(({ e, d }) => (
                  <tr key={e.key}>
                    <td className="c-main">
                      <div className="row gap8" style={{ alignItems: 'flex-start' }}>
                        <d.icon className={`ic ${d.tone === 'g' ? 'green' : d.tone === 'a' ? 'amber' : d.tone === 'r' ? 'red' : 't3'}`} style={{ marginTop: 2 }} aria-hidden />
                        <div className="grow">
                          <div>{d.text}</div>
                          <span className="sub mono">{e.event}{d.requestId !== undefined ? <> · <Link className="link" to={`/app/holds/${d.requestId}`}>{reqId(d.requestId)}</Link></> : null}</span>
                        </div>
                      </div>
                    </td>
                    <td className="mono small t2 c-meta nowrap" data-label="By" title={e.signer}>{acct(e.signer)}</td>
                    <td className="small t3 nowrap c-meta">{dateTime(e.ts_ms)}</td>
                    <td className="num small t3 c-meta c-opt" data-label="Block">{e.block_height.toLocaleString('en-US')}</td>
                    <td className="r c-aside"><a className="link small row gap4" style={{ justifyContent: 'flex-end', display: 'inline-flex' }} href={e.explorer} target="_blank" rel="noreferrer" aria-label={`Open transaction ${e.tx_hash} on NearBlocks`}><span className="mono">{e.tx_hash.slice(0, 8)}</span><ExternalLink className="ic" style={{ width: 12, height: 12 }} aria-hidden /></a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="small t3 mt16">Source: FastNEAR transactions API (free, testnet), cached by the local API. {events ? <Tag>{events.length} events</Tag> : null}</p>
    </>
  );
}
