import { Link } from 'react-router-dom';
import type { Request } from '../lib/types';
import { STATUS_LABEL, acct, amt, reqId, short, tierOf } from '../lib/format';
import { Tag } from './ui';

export function StatusTag({ r }: { r: Request }) {
  const tone = r.status === 'Held' || r.status === 'PendingScore' ? 'a' : r.status === 'Rescued' || r.status === 'Executed' ? 'g' : r.status === 'Failed' ? 'r' : undefined;
  return <Tag tone={tone} dot={tone === 'a'}>{r.hot && r.status === 'Executed' ? 'Sent · hot' : STATUS_LABEL[r.status]}</Tag>;
}

export function RiskTag({ r }: { r: Request }) {
  if (!r.score) return r.hot ? <Tag>hot</Tag> : <Tag>unscored</Tag>;
  const t = tierOf(r.score.score);
  return <Tag tone={t.tone === 'red' ? 'r' : t.tone === 'amber' ? 'a' : undefined}>risk {r.score.score}</Tag>;
}

export function ReqLink({ r }: { r: Request }) {
  return <Link className="link mono" to={`/app/holds/${r.id}`}>{reqId(r.id)}</Link>;
}

export function describe(r: Request) {
  return `${amt(r.asset, r.amount)} to ${r.asset === 'Near' ? acct(r.to) : short(r.to, 6, 4)}`;
}

export function who(r: Request) {
  return r.agent ? `agent: ${r.agent}` : acct(r.requester);
}
