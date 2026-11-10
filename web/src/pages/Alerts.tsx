import { useEffect, useState } from 'react';
import { Bell, ExternalLink, Mail, MessageSquare, Webhook } from 'lucide-react';
import { Card, Empty, Kv, Skeleton, Tag } from '../components/ui';
import { api } from '../lib/api';
import { dateTime } from '../lib/format';

interface Channels { telegram: boolean; webhook: boolean; webhook_signed: boolean; email: boolean; app_url: string }
interface Sent { kind: string; severity: string; title: string; body: string; vault: string; buttons: { text: string; url: string }[]; explorer?: string; at: string; key: string; delivery: Record<string, string> }

export function Alerts() {
  const [d, setD] = useState<{ channels: Channels | null; recent: Sent[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const load = () => api<{ channels: Channels | null; recent: Sent[] }>('/alerts').then((x) => { setD(x); setErr(null); }).catch((e) => setErr(e.message));
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, []);
  const ch = d?.channels;
  const CH = [
    { icon: Bell, name: 'Contract events', on: true, env: 'always on', note: 'The local API indexes NEP-297 events and turns holds, rescues, claims and upgrades into alerts' },
    { icon: MessageSquare, name: 'Telegram', on: !!ch?.telegram, env: 'TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID', note: 'URL buttons to signing pages (needs a public https APP_URL; otherwise links go in the text)' },
    { icon: Webhook, name: 'Webhook', on: !!ch?.webhook, env: 'ALERT_WEBHOOK_URL, ALERT_WEBHOOK_SECRET', note: ch?.webhook && !ch.webhook_signed ? 'Sending unsigned: set ALERT_WEBHOOK_SECRET' : 'JSON POST signed with HMAC-SHA256 over timestamp.body' },
    { icon: Mail, name: 'Email', on: !!ch?.email, env: 'SMTP_URL, ALERT_EMAIL_TO', note: 'Any SMTP server; plain text plus HTML with link buttons' },
  ];
  return (
    <>
      <div className="phead">
        <div>
          <h1 className="ptitle">Alerts</h1>
          <p className="psub">Alerts tell people a hold exists. Their buttons only open a signing page; they never sign anything themselves.</p>
        </div>
      </div>
      {err && <div className="banner a mt24 small" role="status">The local API is not running ({err}). Start it with <span className="mono">npm run api</span>.</div>}
      <div className="split mt24">
        <Card title="Recent alerts" aside={d ? `${d.recent.length} shown` : undefined}>
          {!d ? (
            <div className="pad stack g12">{[0, 1, 2].map((i) => <Skeleton key={i} h={36} />)}</div>
          ) : d.recent.length === 0 ? (
            <Empty title="No alerts yet">They appear when the watcher holds a request, guardians rescue, or a claim is filed.</Empty>
          ) : (
            <ul className="list" style={{ listStyle: 'none' }}>
              {d.recent.map((a) => (
                <li key={a.key} className="li" style={{ alignItems: 'flex-start', paddingTop: 14, paddingBottom: 14 }}>
                  <Tag tone={a.severity === 'critical' ? 'r' : a.severity === 'high' ? 'a' : undefined}>{a.kind}</Tag>
                  <div className="grow stack g4">
                    <div>{a.title}</div>
                    <div className="small t3">{a.body}</div>
                    <div className="row gap8 wrap mt8">
                      {a.buttons.map((b) => <a key={b.url} className="btn sm" href={new URL(b.url).pathname}>{b.text}</a>)}
                      {a.explorer && <a className="btn ghost sm" href={a.explorer} target="_blank" rel="noreferrer">Transaction<ExternalLink className="ic" /></a>}
                    </div>
                    <div className="small t3 mono">{dateTime(Date.parse(a.at))} · {a.vault.split('.')[0]} · {Object.entries(a.delivery).map(([k, v]) => `${k}: ${v.startsWith('skipped') ? 'off' : v}`).join(' · ')}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Channels" aside="set in .env">
          <ul className="list" style={{ listStyle: 'none' }}>
            {CH.map((c) => (
              <li key={c.name} className="li" style={{ alignItems: 'flex-start', paddingTop: 14, paddingBottom: 14 }}>
                <c.icon className="ic t3" aria-hidden style={{ marginTop: 2 }} />
                <div className="grow stack g4"><div>{c.name}</div><div className="small t3">{c.note}</div><div className="small mono t3">{c.env}</div></div>
                <Tag tone={c.on ? 'g' : undefined} dot={c.on}>{c.on ? 'on' : 'off'}</Tag>
              </li>
            ))}
          </ul>
          {ch && <dl><Kv k="Links open"><span className="mono small">{ch.app_url}</span></Kv></dl>}
        </Card>
      </div>
    </>
  );
}
