import { Link } from 'react-router-dom';
import { Ban, CircleCheck, Fingerprint, Hourglass, LifeBuoy, Send, Zap } from 'lucide-react';
import { useVault } from '../components/Shell';
import { Card, Empty, ErrorState, LoadingCards, Tag } from '../components/ui';
import type { Request } from '../lib/types';
import { amt, dateTime, reqId } from '../lib/format';

interface Ev { at: number; icon: typeof Zap; text: React.ReactNode; tag?: React.ReactNode; r: Request }

function events(r: Request): Ev[] {
  const out: Ev[] = [];
  const base = `${amt(r.asset, r.amount)} to ${r.to}`;
  out.push({ at: Number(r.created_ms), icon: r.hot ? Zap : Hourglass, r, text: <>{r.hot ? 'Hot spend' : 'Held request'}: {base}</>, tag: r.hot ? <Tag>hot</Tag> : <Tag tone="a">held</Tag> });
  if (r.score) out.push({ at: Number(r.score.scored_at_ms), icon: Fingerprint, r, text: <>Watcher scored {reqId(r.id)} with signed evidence</>, tag: <Tag tone={r.score.score >= 60 ? 'a' : undefined}>risk {r.score.score}</Tag> });
  for (const g of r.approvals) out.push({ at: Number(r.score?.scored_at_ms || r.created_ms) + 1, icon: LifeBuoy, r, text: <>{g} voted to rescue {reqId(r.id)}</> });
  if (r.status === 'Cancelled') out.push({ at: Number(r.release_ms) + 2, icon: Ban, r, text: <>Owner cancelled {reqId(r.id)}</> });
  if (r.status === 'Rescued') out.push({ at: Number(r.created_ms) + 3, icon: LifeBuoy, r, text: <>Rescued {reqId(r.id)}: funds moved to the safe address</>, tag: <Tag tone="g">rescued</Tag> });
  if (r.status === 'Executed' && !r.hot) out.push({ at: Number(r.release_ms), icon: CircleCheck, r, text: <>Released {reqId(r.id)} after its hold</> });
  if (r.signature) out.push({ at: Number(r.created_ms) + 4, icon: Send, r, text: <>MPC signed Sepolia tx for {reqId(r.id)}</> });
  return out;
}

export function Activity() {
  const { data, error, loading, refresh } = useVault();
  if (loading && !data) return <LoadingCards n={1} />;
  if (!data) return <Card><ErrorState error={error || 'unknown'} onRetry={refresh} /></Card>;
  const evs = data.requests.flatMap(events).sort((a, b) => b.at - a.at);
  return (
    <>
      <div className="phead">
        <div>
          <h1 className="ptitle">Audit log</h1>
          <p className="psub">Every request, score, vote, cancel and rescue is also emitted on-chain as a NEP-297 event (<span className="mono">standard: rescueroom</span>).</p>
        </div>
      </div>
      <Card className="mt24" title="Timeline" aside="Reconstructed from contract state; event indexer next phase">
        {evs.length === 0 ? <Empty title="No activity yet" /> : (
          <ul className="list" style={{ listStyle: 'none' }}>
            {evs.map((e, i) => (
              <li key={i} className="li">
                <span className="mono small t3" style={{ width: 120, flex: 'none' }}>{dateTime(e.at).replace(' WAT', '')}</span>
                <e.icon className="ic t3" aria-hidden />
                <Link to={`/app/holds/${e.r.id}`} className="grow ellip">{e.text}</Link>
                {e.tag}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
