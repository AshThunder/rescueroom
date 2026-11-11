// "Pattern alert" rows: bursts and slow drips of small instant withdrawals, flagged off-chain by the
// defender's watcher. Recommendations only; nothing on chain changes.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity as Pulse } from 'lucide-react';
import { Card, Tag } from './ui';
import { defender } from '../lib/api';
import { dateTime } from '../lib/format';
import { useActiveVault } from '../lib/active';

export interface PatternAlert { key: string; rule: string; title: string; body: string; at: string; vault: string; request_ids?: number[] }

export function usePatterns() {
  const vault = useActiveVault();
  const [list, setList] = useState<PatternAlert[]>([]);
  useEffect(() => {
    setList([]);
    const load = () => defender<{ recent: PatternAlert[] }>(`/patterns?vault=${encodeURIComponent(vault)}`).then((r) => setList(r.recent)).catch(() => {});
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [vault]);
  return list;
}

const RULE: Record<string, string> = { burst: 'burst', drip: 'slow drip', repeat_recipient: 'new recipient' };

export function PatternAlerts({ hideEmpty = true, recentMs }: { hideEmpty?: boolean; recentMs?: number }) {
  const all = usePatterns();
  const list = recentMs ? all.filter((a) => Date.now() - Date.parse(a.at) < recentMs) : all;
  if (!list.length && hideEmpty) return null;
  return (
    <Card className="mt24" title={<span className="row gap8"><Pulse className="ic amber" aria-hidden />Pattern alerts</span>} aside="watcher, off-chain">
      <ul className="list" style={{ listStyle: 'none' }}>
        {list.map((a) => (
          <li key={a.key + a.at} className="li" style={{ alignItems: 'flex-start', paddingTop: 12, paddingBottom: 12 }}>
            <Tag tone="a">Pattern alert</Tag>
            <div className="grow stack g4" style={{ minWidth: 0 }}>
              <div>{a.title.replace(/^Pattern alert: /, '')}</div>
              <div className="small t3 break">{a.body}</div>
              <div className="row gap8 wrap small"><span className="t3">{dateTime(Date.parse(a.at))} · {RULE[a.rule] || a.rule}</span><Link className="link" to="/app/policy">Tighten allowance</Link><Link className="link" to="/app/connect">Agent keys</Link></div>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
