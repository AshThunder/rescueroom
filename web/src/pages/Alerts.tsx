import { Bell, Mail, MessageSquare, Webhook } from 'lucide-react';
import { Card, Kv, Mock, Tag } from '../components/ui';

const CH = [
  { icon: Bell, name: 'On-chain event', state: 'live', note: 'NEP-297 events from the vault contract' },
  { icon: MessageSquare, name: 'Telegram', state: 'needs bot token', note: 'Bot posts the hold with buttons that open signing pages' },
  { icon: Mail, name: 'Email', state: 'needs SMTP', note: 'Same alert, plain text, signing links' },
  { icon: Webhook, name: 'Webhook', state: 'ready', note: 'POST JSON to your URL, e.g. to pause an agent' },
];

export function Alerts() {
  return (
    <>
      <div className="phead">
        <div>
          <h1 className="ptitle">Alerts</h1>
          <p className="psub">Alerts tell people a hold exists. Their buttons only open a signing page; they never sign anything themselves.</p>
        </div>
        <Mock>channels wired next phase</Mock>
      </div>
      <div className="grid g2 mt24">
        <Card title="Channels">
          <ul className="list" style={{ listStyle: 'none' }}>
            {CH.map((c) => (
              <li key={c.name} className="li">
                <c.icon className="ic t3" aria-hidden />
                <div className="grow"><div>{c.name}</div><div className="small t3">{c.note}</div></div>
                <Tag tone={c.state === 'live' ? 'g' : c.state === 'ready' ? undefined : 'a'}>{c.state}</Tag>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Alert preview" aside={<Mock />}>
          <dl>
            <Kv k="Title">Held: 2 NEAR to attacker…testnet</Kv>
            <Kv k="Why">Risk 100: new destination, chunked drain, agent paying unlisted address</Kv>
            <Kv k="Buttons"><div className="row gap8 wrap"><span className="btn sm amb">Review and vote</span><span className="btn sm">Owner: cancel</span></div></Kv>
            <Kv k="Links to">/app/sign/rescue/&lt;id&gt; and /app/sign/cancel/&lt;id&gt;</Kv>
          </dl>
        </Card>
      </div>
    </>
  );
}
