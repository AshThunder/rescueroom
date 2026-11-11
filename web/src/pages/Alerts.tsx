import { useEffect, useState } from 'react';
import { Bell, ExternalLink, Mail, MessageSquare, Webhook } from 'lucide-react';
import { Card, Empty, Kv, Skeleton, Tag, PageHeader } from '../components/ui';
import { api, defender } from '../lib/api';
import { useVault } from '../components/Shell';
import { useWallet } from '../lib/wallet';
import { useToast } from '../components/Toast';
import { FACTORY, isFactoryVault, useActiveVault, vaultSlug } from '../lib/active';
import { LoaderCircle } from 'lucide-react';
import { dateTime } from '../lib/format';

interface Channels { telegram: boolean; webhook: boolean; webhook_signed: boolean; email: boolean; app_url: string }
interface Sent { kind: string; severity: string; title: string; body: string; vault: string; buttons: { text: string; url: string }[]; explorer?: string; at: string; key: string; delivery: Record<string, string> }

export function Alerts() {
  const vault = useActiveVault();
  if (isFactoryVault(vault)) return <VaultAlerts />;
  return <DemoAlerts />;
}

function DemoAlerts() {
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
      <PageHeader title="Alerts" sub={<>Alerts tell people a hold exists. Their buttons only open a signing page; they never sign anything themselves.</>} />
      {err && <div className="banner a mt24 small" role="status">The API is not reachable ({err}). Locally, start it with <span className="mono">npm run api</span>.</div>}
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
                      {a.buttons.map((b) => <a key={b.url} className="btn sm" href={(() => { const u = new URL(b.url); return u.pathname + u.search; })()}>{b.text}</a>)}
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

const BOT = 'rescueroom_bot';

/** Alerts for a factory vault: Telegram linking through the bot, an optional signed webhook, and recent alerts. */
function VaultAlerts() {
  const { data } = useVault();
  const w = useWallet();
  const toast = useToast();
  const vault = useActiveVault();
  const [recent, setRecent] = useState<Sent[] | null>(null);
  const [down, setDown] = useState(false);
  const [pk, setPk] = useState<string | null>(null);
  const [hook, setHook] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setRecent(null);
    const load = () => defender<{ recent: Sent[] }>(`/alerts?vault=${encodeURIComponent(vault)}`).then((x) => { setRecent(x.recent); setDown(false); }).catch(() => setDown(true));
    load();
    defender<{ webhook_signing_key: string | null }>('/health').then((h) => setPk(h.webhook_signing_key)).catch(() => {});
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [vault]);
  useEffect(() => setHook(data?.info?.alert_webhook || ''), [data?.info?.alert_webhook]);
  const slug = vaultSlug(vault);
  const isOwner = !!data && w.accountId === data.config.owner;
  const valid = hook === '' || (/^https:\/\/\S+$/.test(hook) && hook.length <= 200);
  async function saveHook() {
    setBusy(true);
    try {
      await w.send({ receiver: FACTORY, method: 'set_alert_webhook', args: { vault, url: hook || null }, deposit: 0n, gas: 30n * 10n ** 12n });
      toast.push({ tone: 'ok', title: hook ? 'Webhook saved' : 'Webhook removed' });
    } catch (e) {
      toast.push({ tone: 'err', title: 'Could not save the webhook', body: (e as Error).message.slice(0, 200) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader title="Alerts" sub={<>The defender watches every factory vault and alerts when it holds a request, a rescue happens or keys change. Buttons only open signing pages.</>} />
      {down && <div className="banner a mt24 small" role="status">The defender is not reachable right now; alerts still go out once it is back.</div>}
      <div className="split mt24">
        <Card title="Recent alerts" aside={recent ? `${recent.length} shown` : undefined}>
          {!recent ? (
            <div className="pad stack g12">{[0, 1, 2].map((i) => <Skeleton key={i} h={36} />)}</div>
          ) : recent.length === 0 ? (
            <Empty title="No alerts yet">They appear when the watcher holds a request, guardians rescue or an agent key changes.</Empty>
          ) : (
            <ul className="list" style={{ listStyle: 'none' }}>
              {recent.map((a) => (
                <li key={a.key} className="li" style={{ alignItems: 'flex-start', paddingTop: 14, paddingBottom: 14 }}>
                  <Tag tone={a.severity === 'critical' ? 'r' : a.severity === 'high' ? 'a' : undefined}>{a.kind}</Tag>
                  <div className="grow stack g4">
                    <div>{a.title}</div>
                    <div className="small t3">{a.body}</div>
                    <div className="small t3 mono">{dateTime(Date.parse(a.at))} · {Object.entries(a.delivery).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'no channels linked'}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <div className="stack g16">
          <Card title={<span className="row gap8"><MessageSquare className="ic t3" aria-hidden />Telegram</span>}>
            <div className="pad stack g12">
              <p className="small t2">Open the bot and press Start. That chat then gets this vault's alerts. Send <span className="mono">/stop {slug}</span> to unlink. Alerts carry only public on-chain data.</p>
              <a className="btn amb" style={{ alignSelf: 'flex-start' }} href={`https://t.me/${BOT}?start=${slug}`} target="_blank" rel="noreferrer"><MessageSquare className="ic" />Link Telegram<ExternalLink className="ic" /></a>
              <span className="small t3 mono">t.me/{BOT}?start={slug}</span>
            </div>
          </Card>
          <Card title={<span className="row gap8"><Webhook className="ic t3" aria-hidden />Webhook</span>} aside={data?.info?.alert_webhook ? <Tag tone="g" dot>on</Tag> : <Tag>off</Tag>}>
            <div className="pad stack g12">
              <p className="small t2">JSON POST for each alert, signed with ed25519 over <span className="mono">timestamp.body</span> in <span className="mono">x-rescueroom-signature-ed25519</span>. The URL is stored on chain in the factory, so it is public.</p>
              <div className="field">
                <label htmlFor="hook">https URL</label>
                <input id="hook" className="input mono" value={hook} onChange={(e) => setHook(e.target.value.trim())} placeholder="https://example.com/rescueroom" aria-invalid={!valid} disabled={!isOwner} />
              </div>
              {isOwner ? <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={saveHook} disabled={!valid || busy || hook === (data?.info?.alert_webhook || '')}>{busy && <LoaderCircle className="ic spin" />}{hook ? 'Save webhook' : 'Remove webhook'}</button> : <span className="small t3">Only the owner can set the webhook.</span>}
              {pk && <dl><Kv k="Verify with"><span className="mono small break">{pk}</span></Kv></dl>}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
