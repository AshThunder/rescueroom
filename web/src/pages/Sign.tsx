import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Check, ChevronRight, Copy, PenLine, ShieldCheck } from 'lucide-react';
import { useVault } from '../components/Shell';
import { Card, Empty, ErrorState, Kv, LoadingCards, Mock } from '../components/ui';
import { cliCommand, spec } from '../lib/calls';
import { reqId } from '../lib/format';

export function Sign() {
  const { action = '', id } = useParams();
  const { data, error, loading, refresh } = useVault();
  const [copied, setCopied] = useState(false);
  if (loading && !data) return <LoadingCards n={1} />;
  if (!data) return <Card><ErrorState error={error || 'unknown'} onRetry={refresh} /></Card>;
  const r = data.requests.find((x) => String(x.id) === id);
  const s = spec(action, r, data.config, id);
  if (!s) return <Card><Empty title="Nothing to sign">This link does not match a request on this vault.</Empty></Card>;
  const cmd = cliCommand(s);
  return (
    <>
      <nav className="crumb small" aria-label="Breadcrumb">
        {r ? <><Link className="link" to={`/app/holds/${r.id}`}>{reqId(r.id)}</Link><ChevronRight className="ic" aria-hidden /></> : null}
        <span>Sign</span>
      </nav>
      <div className="phead mt16">
        <div>
          <h1 className="ptitle">{s.title}</h1>
          <p className="psub">Alert buttons only open this page. Nothing is signed until you approve it in your own wallet.</p>
        </div>
      </div>
      <div className="split mt24">
        <Card title="What you are signing" aside="Exact call">
          <dl>
            <Kv k="Signer">{s.signer.includes(' ') ? s.signer : <span className="mono small">{s.signer}</span>}</Kv>
            <Kv k="Contract"><span className="mono small">{s.receiver}</span></Kv>
            <Kv k="Method"><span className="mono">{s.method}</span></Kv>
            <Kv k="Arguments"><pre className="code" style={{ margin: 0 }}>{JSON.stringify(s.args, null, 2)}</pre></Kv>
            <Kv k="Deposit"><span className="mono">{s.deposit === '0' ? 'none' : s.deposit}</span></Kv>
            <Kv k="Gas"><span className="mono">{s.gasTgas} Tgas</span></Kv>
            <Kv k="Effect">{s.effect}</Kv>
          </dl>
        </Card>
        <div className="stack g16">
          <Card title="Approve in a wallet" aside={<Mock>phase 2</Mock>}>
            <div className="pad stack g12">
              <button className="btn pri full lg" disabled aria-describedby="wallet-note"><PenLine className="ic" />Connect wallet to sign</button>
              <p id="wallet-note" className="small t3">Wallet connection lands next phase. Until then, sign the same call with NEAR CLI:</p>
              <pre className="code pre" tabIndex={0} aria-label="NEAR CLI command">{cmd}</pre>
              <button className="btn sm" onClick={() => { navigator.clipboard?.writeText(cmd); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
                {copied ? <Check className="ic" /> : <Copy className="ic" />}{copied ? 'Copied' : 'Copy command'}
              </button>
            </div>
          </Card>
          <div className="banner g small"><ShieldCheck className="ic green" aria-hidden />The vault checks the signer on-chain. A wrong account simply fails; it cannot move funds.</div>
        </div>
      </div>
    </>
  );
}
