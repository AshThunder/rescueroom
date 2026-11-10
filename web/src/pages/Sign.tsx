import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Check, ChevronRight, Copy, ExternalLink, LogOut, PenLine, ShieldCheck, TriangleAlert, Wallet } from 'lucide-react';
import { useVault } from '../components/Shell';
import { Card, Empty, ErrorState, Kv, LoadingCards } from '../components/ui';
import { useToast } from '../components/Toast';
import { cliCommand, spec, type CallSpec, type Field } from '../lib/calls';
import { reqId } from '../lib/format';
import { nearblocksTx, view } from '../lib/near';
import { DEPLOY } from '../lib/useVault';
import { useWallet } from '../lib/wallet';

export function Sign() {
  const { action = '', id } = useParams();
  const { data, error, loading, refresh } = useVault();
  const [bond, setBond] = useState<bigint>();
  useEffect(() => {
    if (action !== 'unfreeze' || !data) return;
    view<{ proposal_bond: string }>(data.config.guardian_dao, 'get_policy').then((p) => setBond(BigInt(p.proposal_bond))).catch(() => {});
  }, [action, data]);
  const [premiums, setPremiums] = useState<Record<string, bigint>>({});
  const s = useMemo(() => {
    if (!data) return null;
    return spec(action, id, {
      config: data.config,
      request: data.requests.find((x) => String(x.id) === id),
      claim: data.claims.find((x) => String(x.id) === id),
      policies: data.policies.filter((p) => p.holder === data.config.owner),
      guardians: data.status.guardians,
      premiumFor: (c) => premiums[c.toString()],
      proposalBond: bond,
    });
  }, [action, id, data, premiums, bond]);
  if (loading && !data) return <LoadingCards n={1} />;
  if (!data) return <Card><ErrorState error={error || 'unknown'} onRetry={refresh} /></Card>;
  if (!s) return <Card><Empty title="Nothing to sign">This link does not match a request or claim on this vault.</Empty></Card>;
  const r = data.requests.find((x) => String(x.id) === id);
  return <SignBody key={s.key + id} s={s} r={r ? r.id : undefined} onQuote={(c) => view<string>(DEPLOY.vault, 'quote_premium', { coverage: c.toString() }).then((p) => setPremiums((m) => ({ ...m, [c.toString()]: BigInt(p) })))} refresh={refresh} />;
}

function SignBody({ s, r, onQuote, refresh }: { s: CallSpec; r?: number; onQuote: (c: bigint) => void; refresh: () => void }) {
  const w = useWallet();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(s.fields.map((f) => [f.name, f.initial])));
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<{ hash: string | null; value?: unknown; failure?: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const built = s.build(vals);
  const ok = !('error' in built);

  // Quote the premium for the cover form.
  const cov = vals.coverage;
  const quoted = useRef('');
  useEffect(() => {
    if (s.key !== 'cover' || !cov || quoted.current === cov) return;
    const t = setTimeout(() => {
      const m = /^\d+(\.\d+)?$/.test(cov) ? cov : null;
      if (!m) return;
      quoted.current = cov;
      const [a, b = ''] = cov.split('.');
      onQuote(BigInt(a) * 10n ** 24n + BigInt((b + '0'.repeat(24)).slice(0, 24) || '0'));
    }, 250);
    return () => clearTimeout(t);
  }, [s.key, cov, onQuote]);

  // Browser wallets (MyNearWallet) redirect back with the result in the query string.
  useEffect(() => {
    const h = params.get('transactionHashes');
    const err = params.get('errorCode');
    if (!h && !err) return;
    if (h) {
      const hash = h.split(',').pop()!;
      setLast({ hash });
      toast.push({ tone: 'ok', title: 'Transaction sent from your wallet', body: <a className="link mono" href={nearblocksTx(hash)} target="_blank" rel="noreferrer">{hash.slice(0, 12)}… on NearBlocks</a> });
      refresh();
    } else toast.push({ tone: 'err', title: 'Wallet did not sign', body: decodeURIComponent(params.get('errorMessage') || err || '') });
    setParams({}, { replace: true });
  }, [params, setParams, toast, refresh]);

  const wrongSigner = w.accountId && s.expectedSigners && !s.expectedSigners.includes(w.accountId);
  const cmd = ok ? cliCommand(s, built, w.accountId) : '';

  async function sign() {
    setTouched(true);
    if (!ok) return;
    setBusy(true);
    try {
      const out = await w.send({ receiver: s.receiver, method: s.method, args: built.args, deposit: built.deposit, gas: built.gas });
      setLast(out);
      if (out.failure) toast.push({ tone: 'err', title: 'The contract rejected the call', body: out.failure });
      else if (out.hash) {
        toast.push({ tone: 'ok', title: `${s.title}: sent`, body: <a className="link mono" href={nearblocksTx(out.hash)} target="_blank" rel="noreferrer">{out.hash.slice(0, 12)}… on NearBlocks</a> });
        refresh();
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      toast.push({ tone: 'err', title: /reject|cancel|closed/i.test(m) ? 'You cancelled in the wallet' : 'Signing failed', body: m.slice(0, 200) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <nav className="crumb small" aria-label="Breadcrumb">
        {r !== undefined ? <><Link className="link" to={`/app/holds/${r}`}>{reqId(r)}</Link><ChevronRight className="ic" aria-hidden /></> : null}
        <span>Sign</span>
      </nav>
      <div className="phead mt16">
        <div>
          <h1 className="ptitle">{s.title}</h1>
          <p className="psub">Alert buttons only open this page. Nothing is signed until you approve it in your own wallet.</p>
        </div>
      </div>
      <div className="split mt24">
        <div className="stack g16">
          {s.fields.length > 0 && (
            <Card title="Details">
              <form className="pad stack g16" onSubmit={(e) => { e.preventDefault(); sign(); }} noValidate>
                {s.fields.map((f) => <FieldInput key={f.name} f={f} value={vals[f.name]} onChange={(v) => setVals((x) => ({ ...x, [f.name]: v }))} />)}
                {touched && !ok && <p className="small red" role="alert">{built.error}</p>}
              </form>
            </Card>
          )}
          <Card title="What you are signing" aside="Exact call">
            <dl>
              <Kv k="Signer">{s.expectedSigners?.length === 1 ? <span className="mono small">{s.expectedSigners[0]}</span> : s.signerLabel}</Kv>
              <Kv k="Contract"><span className="mono small">{s.receiver}</span></Kv>
              <Kv k="Method"><span className="mono">{s.method}</span></Kv>
              <Kv k="Arguments">{ok ? <pre className="code pre" style={{ margin: 0 }}>{JSON.stringify(built.args, null, 2)}</pre> : <span className="t3">{built.error}</span>}</Kv>
              <Kv k="Deposit"><span className="mono">{ok ? built.depositLabel : '…'}</span></Kv>
              <Kv k="Gas"><span className="mono">{ok ? `${built.gas / 10n ** 12n} Tgas` : '…'}</span></Kv>
              <Kv k="Effect">{s.effect}</Kv>
            </dl>
          </Card>
        </div>
        <div className="stack g16 first-m">
          <Card title="Approve in your wallet" aside="NEAR testnet">
            <div className="pad stack g12">
              {w.accountId ? (
                <div className="acctrow">
                  <Wallet className="ic t3" aria-hidden />
                  <div className="grow">
                    <div className="mono small ellip">{w.accountId}</div>
                    <div className="small t3">{w.walletName}</div>
                  </div>
                  <button className="btn ghost sm" onClick={() => w.disconnect().then(() => toast.push({ title: 'Wallet disconnected' }))} aria-label="Disconnect wallet"><LogOut className="ic" /></button>
                </div>
              ) : null}
              {wrongSigner && (
                <div className="banner a small" role="status"><TriangleAlert className="ic amber" aria-hidden /><span>This action expects {s.signerLabel}. The contract will reject it from <span className="mono">{w.accountId}</span>.</span></div>
              )}
              {w.accountId ? (
                <button className="btn pri full lg" onClick={sign} disabled={busy} aria-busy={busy}><PenLine className="ic" />{busy ? 'Waiting for wallet…' : `Sign with ${w.walletName || 'wallet'}`}</button>
              ) : (
                <button className="btn pri full lg" onClick={() => w.connect().catch((e) => toast.push({ tone: 'err', title: 'Could not open the wallet selector', body: String(e.message || e) }))}><Wallet className="ic" />Connect wallet</button>
              )}
              <p className="small t3">MyNearWallet, Meteor or HERE. Your wallet shows this same call before you approve it.</p>
              {last?.hash && (
                <a className="banner g small" href={nearblocksTx(last.hash)} target="_blank" rel="noreferrer"><Check className="ic green" aria-hidden /><span className="grow">Sent <span className="mono">{last.hash.slice(0, 16)}…</span>{last.value !== undefined ? <> · returned <span className="mono">{JSON.stringify(last.value)}</span></> : null}</span><ExternalLink className="ic t3" aria-hidden /></a>
              )}
            </div>
          </Card>
          <details className="card disclose">
            <summary className="chead"><h3>Or sign with NEAR CLI</h3><ChevronRight className="ic t3 chev" aria-hidden /></summary>
            <div className="pad stack g12">
              {ok ? <pre className="code pre" tabIndex={0} aria-label="NEAR CLI command">{cmd}</pre> : <p className="small t3">Fill in the details first.</p>}
              <button className="btn sm" disabled={!ok} onClick={() => { navigator.clipboard?.writeText(cmd); setCopied(true); toast.push({ tone: 'ok', title: 'Command copied' }); setTimeout(() => setCopied(false), 1500); }}>
                {copied ? <Check className="ic" /> : <Copy className="ic" />}{copied ? 'Copied' : 'Copy command'}
              </button>
            </div>
          </details>
          <div className="banner g small"><ShieldCheck className="ic green" aria-hidden />The vault checks the signer on-chain. A wrong account simply fails; it cannot move funds.</div>
        </div>
      </div>
    </>
  );
}

function FieldInput({ f, value, onChange }: { f: Field; value: string; onChange: (v: string) => void }) {
  const id = `f-${f.name}`;
  return (
    <div className="field">
      <label htmlFor={id}>{f.label}</label>
      {f.kind === 'select' ? (
        <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value)}>
          {f.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : (
        <input id={id} className={`input ${f.mono ? 'mono' : ''}`} value={value} placeholder={f.placeholder} inputMode={f.kind === 'amount' ? 'decimal' : f.kind === 'number' ? 'numeric' : undefined} autoComplete="off" spellCheck={false} onChange={(e) => onChange(e.target.value)} aria-describedby={f.hint ? `${id}-h` : undefined} />
      )}
      {f.hint && <span id={`${id}-h`} className="hint">{f.hint}</span>}
    </div>
  );
}
